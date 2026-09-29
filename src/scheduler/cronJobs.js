'use strict';

const cron            = require('node-cron');
const sql             = require('mssql');
const dbConfig        = require('../config/dbConfig');
const dbService       = require('../services/dbService');
const sfService       = require('../services/sfService');
const ehrService      = require('../services/ehrService');
const mapper          = require('../utils/dataMapper');
const syncController  = require('../controllers/syncController');

// ─────────────────────────────────────────────────────────────────────────────
// Logging helpers
// ─────────────────────────────────────────────────────────────────────────────

const TIMEZONE = 'Asia/Kolkata';

function utcTs() {
    return new Date().toISOString().replace('T', ' ').slice(0, 23) + ' UTC';
}

function istTs() {
    return new Date().toLocaleString('en-IN', {
        timeZone    : TIMEZONE,
        year        : 'numeric',
        month       : '2-digit',
        day         : '2-digit',
        hour        : '2-digit',
        minute      : '2-digit',
        second      : '2-digit',
        hour12      : false,
    });
}

function elapsed(startMs) {
    return `${((Date.now() - startMs) / 1000).toFixed(2)}s`;
}

const log = {
    info  : (...a) => console.log (`[${utcTs()}] [IST ${istTs()}] [CRON] ℹ️  `, ...a),
    ok    : (...a) => console.log (`[${utcTs()}] [IST ${istTs()}] [CRON] ✅ `, ...a),
    warn  : (...a) => console.warn (`[${utcTs()}] [IST ${istTs()}] [CRON] ⚠️  `, ...a),
    error : (...a) => console.error(`[${utcTs()}] [IST ${istTs()}] [CRON] ❌ `, ...a),
    banner: (title) => {
        const line = '─'.repeat(60);
        console.log(`\n${line}\n  ${title}\n${line}`);
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Guard flags — prevent overlapping runs if a job exceeds its interval
// ─────────────────────────────────────────────────────────────────────────────

let stockSyncRunning         = false;
let outstandingSyncRunning   = false;
let checkInRunning           = false;
let checkOutRunning          = false;
let ehrCheckInRunning        = false;
let ehrCheckOutRunning       = false;
let stockInventoryApiRunning = false;
let productApiSyncRunning    = false;
let priceListApiSyncRunning  = false;
let bpApiSyncRunning         = false;

// ─────────────────────────────────────────────────────────────────────────────
// Stock inventory sync
// ─────────────────────────────────────────────────────────────────────────────

async function runStockInventorySync() {
    if (stockSyncRunning) {
        log.warn('Stock inventory sync already in progress — skipping this tick.');
        return;
    }
    stockSyncRunning = true;
    const startTime = Date.now();
    log.banner('STOCK INVENTORY SYNC START');
    log.info('Job: runStockInventorySync | IST trigger time noted above');

    try {
        log.info('Fetching stock data from DB…');
        const sqlData = await dbService.getStockData();
        log.info(`Fetched ${sqlData.length} raw DB row(s)`);

        if (!sqlData.length) {
            log.warn('No stock data found in DB — nothing to sync.');
            return;
        }

        const payload = mapper.mapToStockPayload(sqlData);
        log.info(`Mapped to ${payload.length} stock record(s)`);

        if (!payload.length) {
            log.warn('Mapper produced 0 records — nothing to sync.');
            return;
        }

        const sfResult = await sfService.upsertStockInventory(payload);

        log.ok(`Stock Inventory Sync COMPLETE — elapsed: ${elapsed(startTime)}`);
        log.info(`  DB rows fetched : ${sqlData.length}`);
        log.info(`  Records sent    : ${sfResult.totalRecords}`);
        log.ok  (`  Succeeded       : ${sfResult.successRecords}`);
        if (sfResult.failedRecords > 0)
            log.error(`  Failed          : ${sfResult.failedRecords}`);

    } catch (err) {
        log.error(`Stock Inventory Sync FAILED after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
    } finally {
        stockSyncRunning = false;
        log.banner('STOCK INVENTORY SYNC END');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock inventory API sync — calls syncController.syncStockInventory directly
// (same mock req/res adapter pattern used by pushController.js) so the
// scheduled run and the manual POST /api/sync/stockInventory endpoint always
// share one implementation.
// ─────────────────────────────────────────────────────────────────────────────

function buildMockContext() {
    let resolver;
    const promise = new Promise((resolve) => { resolver = resolve; });
    const mockRes = {
        _code: 200,
        status(code) { this._code = code; return this; },
        json(data)   { resolver({ statusCode: this._code, data }); },
    };
    return { mockReq: { body: {} }, mockRes, promise };
}

async function runStockInventoryApiSync() {
    if (stockInventoryApiRunning) {
        log.warn('Stock Inventory API sync already in progress — skipping this tick.');
        return;
    }
    stockInventoryApiRunning = true;
    const startTime = Date.now();
    log.banner('STOCK INVENTORY API SYNC START');
    log.info('Job: runStockInventoryApiSync → syncController.syncStockInventory');

    try {
        const { mockReq, mockRes, promise } = buildMockContext();
        syncController.syncStockInventory(mockReq, mockRes);
        const result = await promise;

        if (result.statusCode >= 200 && result.statusCode < 300) {
            log.ok(`Stock Inventory API Sync COMPLETE — elapsed: ${elapsed(startTime)}`);
        } else {
            log.error(`Stock Inventory API Sync returned HTTP ${result.statusCode} — elapsed: ${elapsed(startTime)}`);
        }
        log.info(`  Response: ${JSON.stringify(result.data)}`);

    } catch (err) {
        log.error(`Stock Inventory API Sync FAILED after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
    } finally {
        stockInventoryApiRunning = false;
        log.banner('STOCK INVENTORY API SYNC END');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Product API sync — one item at a time, driven by OITM.U_SFATriggerStatus
// (active items only: U_SFAItemActiveStatus = 'Yes').
// Calls syncController.syncNextTriggeredProduct directly (same mock req/res
// adapter pattern as runStockInventoryApiSync) so the scheduled run and the
// manual POST /api/sync/productTrigger endpoint share one implementation.
// Only marks the OITM row 'Y' when the sync actually succeeds; otherwise the
// item is left pending (not 'Y') so the next run retries it.
// ─────────────────────────────────────────────────────────────────────────────

async function runProductApiSync() {
    if (productApiSyncRunning) {
        log.warn('Product API sync already in progress — skipping this tick.');
        return;
    }
    productApiSyncRunning = true;
    const startTime = Date.now();
    log.banner('PRODUCT API SYNC START');
    log.info('Job: runProductApiSync → syncController.syncNextTriggeredProduct');

    try {
        const { mockReq, mockRes, promise } = buildMockContext();
        syncController.syncNextTriggeredProduct(mockReq, mockRes);
        const result = await promise;

        if (result.statusCode >= 200 && result.statusCode < 300) {
            log.ok(`Product API Sync COMPLETE — elapsed: ${elapsed(startTime)}`);
        } else {
            log.error(`Product API Sync returned HTTP ${result.statusCode} — elapsed: ${elapsed(startTime)}`);
        }
        log.info(`  Response: ${JSON.stringify(result.data)}`);

    } catch (err) {
        log.error(`Product API Sync FAILED after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
    } finally {
        productApiSyncRunning = false;
        log.banner('PRODUCT API SYNC END');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Price List API sync — scheduled only. Pulls ONLY the rows whose price/MRP
// changed since the previous approved revision (@AINS_* log tables) from both
// Price List Master (@INS_OPLM) and Price List Setup (@INS_OPLSN), maps them to
// the standard PriceList payload and pushes them to Salesforce.
// The manual POST /api/sync/pricelists endpoint (syncController.syncPriceLists)
// is untouched and still performs the full sync.
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_LIST_CHANGES_QUERY = `
;WITH
-- ================= PRICE LIST MASTER =================
curM AS (
    SELECT  T1.DocEntry, T1.U_ItemCode, T1.U_ItemName, T1.UpdateDate,
            I.U_SubGrp1, I.U_SubGrp5,
            T0.LineId, T0.U_RowId, T0.U_State, T0.U_SelPrice, T0.U_MRP
    FROM [BBLive].[dbo].[@INS_PLM2] T0
    INNER JOIN [BBLive].[dbo].[@INS_OPLM] T1 ON T1.DocEntry = T0.DocEntry
    INNER JOIN [BBLive].[dbo].[@INS_PLM1] T2 ON T2.DocEntry = T0.DocEntry
                                            AND T2.LineId = T0.U_RowId
    INNER JOIN [BBLive].[dbo].OITM I ON I.ItemCode = T1.U_ItemCode
    WHERE T2.U_Lock = 'N'
      AND T0.U_MRP > 0
      AND I.validFor = 'Y'
      AND I.U_SubGrp1 NOT IN (
          'ARISER SHIRT',
          'UATHAYAM RDY',
          'ARISER MENS TROUSERS'
      )
),
prevM AS (
    SELECT D.DocEntry, P.LogInst
    FROM (SELECT DISTINCT DocEntry FROM curM) D
    CROSS APPLY (
        SELECT A.LogInst
        FROM [BBLive].[dbo].[@AINS_OPLM] A
        WHERE A.DocEntry = D.DocEntry
        ORDER BY A.LogInst DESC
        OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY
    ) P
),
-- ================= PRICE LIST SETUP =================
curS AS (
    SELECT T0.DocEntry, T0.UpdateDate,
           T1.U_SubGroup1, T1.U_SubGroup4, T1.U_SubGroup7,
           T3.U_UniqId, T3.U_Size,
           CAST(T2.U_Code AS VARCHAR(50)) AS U_State,
           T3.U_SelPrice, T3.U_MRP
    FROM [BBLive].[dbo].[@INS_OPLSN] T0
    INNER JOIN [BBLive].[dbo].[@INS_PLSN1] T1
        ON T1.DocEntry = T0.DocEntry
    INNER JOIN [BBLive].[dbo].[@INS_PLSN3] T3
        ON T3.DocEntry = T0.DocEntry
       AND T3.U_UniqId = T1.LineId
    INNER JOIN [BBLive].[dbo].[@INS_PLSN2] T2
        ON T2.DocEntry = T0.DocEntry
       AND T2.U_Selected = 'Y'
    WHERE T3.U_Lock <> 'Y'
      AND T3.U_MRP > 0
      AND T0.U_DocDate > '20260101'
      AND T1.U_SubGroup1 IN (
          'ARISER SHIRT',
          'UATHAYAM RDY',
          'ARISER MENS TROUSERS'
      )
),
prevS AS (
    SELECT D.DocEntry, P.LogInst
    FROM (SELECT DISTINCT DocEntry FROM curS) D
    CROSS APPLY (
        SELECT A.LogInst
        FROM [BBLive].[dbo].[@AINS_OPLSN] A
        WHERE A.DocEntry = D.DocEntry
        ORDER BY A.LogInst DESC
        OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY
    ) P
),
chgS AS (
    SELECT C.DocEntry, C.UpdateDate,
           C.U_SubGroup1, C.U_SubGroup4, C.U_SubGroup7,
           C.U_UniqId, C.U_Size, C.U_State, C.U_SelPrice, C.U_MRP,
           O.U_SelPrice AS OldPrice,
           O.U_MRP AS OldMRP
    FROM curS C
    INNER JOIN prevS V ON V.DocEntry = C.DocEntry
    INNER JOIN [BBLive].[dbo].[@AINS_PLSN3] O
        ON O.DocEntry = V.DocEntry
       AND O.LogInst = V.LogInst
       AND O.U_UniqId = C.U_UniqId
       AND O.U_Size = C.U_Size
    WHERE ISNULL(C.U_SelPrice, 0) <> ISNULL(O.U_SelPrice, 0)
       OR ISNULL(C.U_MRP, 0) <> ISNULL(O.U_MRP, 0)
)
-- ================= COMBINE (only changed rows) =================
SELECT 'Price List Master' AS Source,
       C.U_ItemCode AS ItemCode,
       C.U_ItemName AS ItemName,
       C.U_SubGrp1 AS Brand,
       CAST(C.U_State AS VARCHAR(50)) AS State,
       CAST(C.U_SubGrp5 AS VARCHAR(50)) AS Size,
       C.U_SelPrice AS Price,
       C.U_MRP AS MRP,
       O.U_SelPrice AS OldPrice,
       O.U_MRP AS OldMRP,
       'Price Changed' AS Remark,
       C.DocEntry AS DocEntry,
       C.UpdateDate,
       C.LineId AS PriceID
FROM curM C
INNER JOIN prevM V ON V.DocEntry = C.DocEntry
INNER JOIN [BBLive].[dbo].[@AINS_PLM2] O
    ON O.DocEntry = V.DocEntry
   AND O.LogInst = V.LogInst
   AND O.U_RowId = C.U_RowId
   AND O.U_State = C.U_State
WHERE ISNULL(C.U_SelPrice, 0) <> ISNULL(O.U_SelPrice, 0)
   OR ISNULL(C.U_MRP, 0) <> ISNULL(O.U_MRP, 0)

UNION ALL

SELECT 'Price List Setup',
       I.ItemCode,
       I.ItemName,
       I.U_SubGrp1,
       S.U_State,
       CAST(S.U_Size AS VARCHAR(50)),
       S.U_SelPrice,
       S.U_MRP,
       S.OldPrice,
       S.OldMRP,
       'Price Changed',
       S.DocEntry,
       S.UpdateDate,
       S.U_UniqId
FROM chgS S
INNER JOIN [BBLive].[dbo].OITM I
    ON I.U_SubGrp1 = S.U_SubGroup1
   AND I.U_SubGrp4 = S.U_SubGroup4
   AND I.U_SubGrp7 = S.U_SubGroup7
   AND I.U_SubGrp5 = S.U_Size
WHERE I.validFor = 'Y'

ORDER BY Source, ItemCode, State
OPTION (RECOMPILE);`;

let priceListSyncPool = null;

async function runPriceListApiSync() {
    if (priceListApiSyncRunning) {
        log.warn('Price List API sync already in progress — skipping this tick.');
        return;
    }
    priceListApiSyncRunning = true;
    const startTime = Date.now();
    log.banner('PRICE LIST API SYNC START');
    log.info('Job: runPriceListApiSync → changed-price query (Price List Master + Price List Setup)');

    try {
        // Same DB config as dbService, but a dedicated pool with a longer request
        // timeout — the change-detection query exceeds mssql's 15s default.
        let rows;
        try {
            if (!priceListSyncPool) {
                priceListSyncPool = new sql.ConnectionPool({
                    ...dbConfig,
                    requestTimeout: parseInt(process.env.PRICE_LIST_SYNC_TIMEOUT_MS, 10) || 300000,
                }).connect().catch((e) => { priceListSyncPool = null; throw e; });
            }
            const pool = await priceListSyncPool;
            rows = (await pool.request().query(PRICE_LIST_CHANGES_QUERY)).recordset || [];
        } catch (sqlErr) {
            throw new Error(`SQL Error (PriceList changes): ${sqlErr.message}`);
        }
        log.info(`Fetched ${rows.length} changed price row(s) from DB`);

        // De-duplicate on ItemCode + DocEntry + State, keeping the latest UpdateDate.
        const unique  = new Map();
        const skipped = [];
        for (const r of rows) {
            const itemCode = r.ItemCode != null ? String(r.ItemCode).trim() : '';
            const state    = r.State    != null ? String(r.State).trim()    : '';
            if (!itemCode || !state || r.DocEntry == null) {
                skipped.push({ source: r.Source, itemCode, state, docEntry: r.DocEntry, reason: 'Missing ItemCode/State/DocEntry' });
                continue;
            }
            if (r.Price == null || Number(r.Price) <= 0) {
                skipped.push({ source: r.Source, itemCode, state, docEntry: r.DocEntry, reason: 'Price is NULL or 0' });
                continue;
            }
            const key  = `${itemCode}|${r.DocEntry}|${state}`;
            const prev = unique.get(key);
            if (!prev || new Date(r.UpdateDate || 0) > new Date(prev.UpdateDate || 0)) {
                unique.set(key, { ...r, ItemCode: itemCode, State: state });
            }
        }
        const changes = Array.from(unique.values());
        const bySource = changes.reduce((acc, r) => { acc[r.Source] = (acc[r.Source] || 0) + 1; return acc; }, {});

        log.info(`  Unique changes  : ${changes.length} (duplicates removed: ${rows.length - skipped.length - changes.length})`);
        log.info(`  Price List Master: ${bySource['Price List Master'] || 0} | Price List Setup: ${bySource['Price List Setup'] || 0}`);
        if (skipped.length) log.warn(`  Skipped rows    : ${skipped.length} — ${JSON.stringify(skipped.slice(0, 10))}`);
        changes.slice(0, 10).forEach(r =>
            log.info(`  [${r.Source}] ${r.ItemCode} ${r.State} size=${r.Size ?? '-'} doc=${r.DocEntry} ` +
                     `Price ${r.OldPrice ?? 'NULL'} → ${r.Price} | MRP ${r.OldMRP ?? 'NULL'} → ${r.MRP ?? 'NULL'}`)
        );

        let result;
        if (!changes.length) {
            result = { statusCode: 200, data: { message: 'No price changes found.', dbRowsFetched: rows.length, skipped: skipped.length } };
        } else {
            const payload = mapper.mapToPriceListPayload(changes.map(r => ({
                ProductCode      : r.ItemCode,
                PriceListID      : r.DocEntry,
                SubBrandCode     : r.State,
                BPProductName    : r.ItemName ?? r.ItemCode,
                PriceListCode    : r.State,
                EffectiveFrom    : null,
                EffectiveTo      : null,
                PriceListIsActive: 1,
                BPCategory       : 'Dealer',
                Price            : Number(r.Price),
                MRP              : r.MRP != null ? Number(r.MRP) : 0,
                PriceID          : r.PriceID ?? null,
                PriceIsActive    : 1,
            })));
            log.info(`Mapped to ${payload.length} product price record(s)`);

            const sfResult = await sfService.upsertPriceLists(payload);
            result = {
                statusCode: 200,
                data: {
                    message      : sfResult.failedBatches === 0
                        ? 'PriceList Sync Completed Successfully'
                        : 'PriceList Sync Completed with some batch failures',
                    elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
                    mode          : 'changes',
                    dbRowsFetched : rows.length,
                    uniqueChanges : changes.length,
                    bySource,
                    skipped       : skipped.length,
                    recordsSent   : payload.length,
                    ...sfResult
                }
            };
        }

        if (result.statusCode >= 200 && result.statusCode < 300) {
            log.ok(`Price List API Sync COMPLETE — elapsed: ${elapsed(startTime)}`);
        } else {
            log.error(`Price List API Sync returned HTTP ${result.statusCode} — elapsed: ${elapsed(startTime)}`);
        }
        log.info(`  Response: ${JSON.stringify(result.data)}`);

    } catch (err) {
        log.error(`Price List API Sync FAILED after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
    } finally {
        priceListApiSyncRunning = false;
        log.banner('PRICE LIST API SYNC END');
    }
}

async function runBusinessPartnerApiSync() {
    if (bpApiSyncRunning) {
        log.warn('Business Partner API sync already in progress — skipping this tick.');
        return;
    }
    bpApiSyncRunning = true;
    const startTime = Date.now();
    log.banner('BUSINESS PARTNER API SYNC START');
    log.info('Job: runBusinessPartnerApiSync → syncController.syncNextTriggeredBusinessPartner');

    try {
        const { mockReq, mockRes, promise } = buildMockContext();
        syncController.syncNextTriggeredBusinessPartner(mockReq, mockRes);
        const result = await promise;

        if (result.statusCode >= 200 && result.statusCode < 300) {
            log.ok(`Business Partner API Sync COMPLETE — elapsed: ${elapsed(startTime)}`);
        } else {
            log.error(`Business Partner API Sync returned HTTP ${result.statusCode} — elapsed: ${elapsed(startTime)}`);
        }
        log.info(`  Response: ${JSON.stringify(result.data)}`);

    } catch (err) {
        log.error(`Business Partner API Sync FAILED after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
    } finally {
        bpApiSyncRunning = false;
        log.banner('BUSINESS PARTNER API SYNC END');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Outstanding sync
// ─────────────────────────────────────────────────────────────────────────────

async function runOutstandingSync() {
    if (outstandingSyncRunning) {
        log.warn('Outstanding sync already in progress — skipping this tick.');
        return;
    }
    outstandingSyncRunning = true;
    const startTime = Date.now();
    log.banner('OUTSTANDING SYNC START');
    log.info('Job: runOutstandingSync | IST trigger time noted above');

    try {
        log.info('Fetching outstanding data from DB…');
        const sqlData = await dbService.getOutstandingData();
        log.info(`Fetched ${sqlData.length} raw DB row(s)`);

        if (!sqlData.length) {
            log.warn('No outstanding data found in DB — nothing to sync.');
            return;
        }

        const payload = mapper.mapToOutstandingPayload(sqlData);
        log.info(`Mapped to ${payload.length} outstanding record(s)`);

        if (!payload.length) {
            log.warn('Mapper produced 0 records — nothing to sync.');
            return;
        }

        const sfResult = await sfService.upsertOutstanding(payload);

        log.ok(`Outstanding Sync COMPLETE — elapsed: ${elapsed(startTime)}`);
        log.info(`  DB rows fetched : ${sqlData.length}`);
        log.info(`  Records sent    : ${sfResult.totalRecords}`);
        log.ok  (`  Succeeded       : ${sfResult.successRecords}`);
        if (sfResult.failedRecords > 0)
            log.error(`  Failed          : ${sfResult.failedRecords}`);

    } catch (err) {
        log.error(`Outstanding Sync FAILED after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
    } finally {
        outstandingSyncRunning = false;
        log.banner('OUTSTANDING SYNC END');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Attendance sync (Check-In at 14:00 IST, Check-Out at 23:30 IST)
// ─────────────────────────────────────────────────────────────────────────────

async function runAttendanceSync(punchTypeLabel, punchTypeCode) {
    const isCheckIn = punchTypeCode === 'I';
    const getGuard  = ()  => isCheckIn ? checkInRunning  : checkOutRunning;
    const setGuard  = (v) => { if (isCheckIn) checkInRunning = v; else checkOutRunning = v; };

    if (getGuard()) {
        log.warn(`Attendance ${punchTypeLabel} sync already in progress — skipping this tick.`);
        return;
    }
    setGuard(true);
    const startTime = Date.now();
    log.banner(`ATTENDANCE ${punchTypeLabel.toUpperCase()} SYNC START`);
    log.info(`Job: runAttendanceSync | PunchType: ${punchTypeCode} (${punchTypeLabel}) | IST trigger time noted above`);

    try {
        log.info(`Fetching ${punchTypeLabel} records from Salesforce…`);
        const sfRecords = await sfService.fetchAttendanceRecords(punchTypeLabel);
        log.info(`Fetched ${sfRecords.length} ${punchTypeLabel} record(s) from Salesforce`);

        if (!sfRecords.length) {
            log.warn(`No ${punchTypeLabel} records in Salesforce — nothing to sync.`);
            return;
        }

        if (!sfRecords.length) {
            log.warn(`No ${punchTypeLabel} records in Salesforce — nothing to sync.`);
            return;
        }

        // Sort by EmployeeId then AttendenceTime__c
        // Check-In (I) -> ascending | Check-Out (O) -> descending
        sfRecords.sort((a, b) => {
            const empA = a.dmpl__ResourceId__r?.EmployeeId__c || '';
            const empB = b.dmpl__ResourceId__r?.EmployeeId__c || '';

            if (empA !== empB) {
                return isCheckIn
                    ? empA.localeCompare(empB)   
                    : empB.localeCompare(empA); 
            }

            const timeA = new Date(a.AttendenceTime__c).getTime();
            const timeB = new Date(b.AttendenceTime__c).getTime();

            return isCheckIn
                ? timeA - timeB   
                : timeB - timeA;  
        });

        let inserted = 0, skipped = 0, failed = 0;
        
        for (const record of sfRecords) {
            const RefId      = record.Id;
            const EmployeeId = record.dmpl__ResourceId__r?.EmployeeId__c;
            const PunchTime  = record.AttendenceTime__c;

            if (!EmployeeId || !PunchTime) {
                log.warn(`  Skipping RefId ${RefId} — missing EmployeeId or PunchTime`);
                skipped++;
                continue;
            }

            try {
                const result = await dbService.insertPunchLog({
                    RefId, EmployeeId, PunchType: punchTypeCode, PunchTime,
                });

                if (result.skipped) {
                    log.info(`  Duplicate skipped — RefId: ${RefId}`);
                    skipped++;
                } else {
                    log.info(`  Inserted (Pending) — RefId: ${RefId} | Employee: ${EmployeeId}`);
                    inserted++;
                }
            } catch (err) {
                log.error(`  Insert FAILED — RefId: ${RefId} | ${err.message}`);
                try { await dbService.updatePunchLogStatus(RefId, 'Failed'); } catch (_) {}
                failed++;
            }
        }

        log.ok(`Attendance ${punchTypeLabel} Sync COMPLETE — elapsed: ${elapsed(startTime)}`);
        log.info(`  Inserted (Pending) : ${inserted}`);
        log.info(`  Skipped (dup/null) : ${skipped}`);
        if (failed > 0) log.error(`  Failed             : ${failed}`);

    } catch (err) {
        log.error(`Attendance ${punchTypeLabel} Sync FAILED after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
    } finally {
        setGuard(false);
        log.banner(`ATTENDANCE ${punchTypeLabel.toUpperCase()} SYNC END`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EHR push sync (Check-In and Check-Out — every 90 minutes)
// ─────────────────────────────────────────────────────────────────────────────

async function runEhrPushSync(punchTypeCode) {
    const label     = punchTypeCode === 'I' ? 'Check-In' : 'Check-Out';
    const isCheckIn = punchTypeCode === 'I';
    const getGuard  = ()  => isCheckIn ? ehrCheckInRunning  : ehrCheckOutRunning;
    const setGuard  = (v) => { if (isCheckIn) ehrCheckInRunning = v; else ehrCheckOutRunning = v; };

    if (getGuard()) {
        log.warn(`EHR ${label} push already in progress — skipping this tick.`);
        return;
    }
    setGuard(true);
    const startTime   = Date.now();
    const triggeredAt = new Date();
    const jobKey      = punchTypeCode === 'I' ? 'EHR_CHECKIN' : 'EHR_CHECKOUT';

    const requiredVars = ['EHR_TOKEN_URL', 'EHR_BASE_URL', 'EHR_CLIENT_ID', 'EHR_CLIENT_SECRET'];
    const missingVars  = requiredVars.filter(k => !process.env[k]);
    if (missingVars.length) {
        setGuard(false);
        return;
    }
    log.info(`ENV check OK | EHR_TOKEN_URL: ${process.env.EHR_TOKEN_URL} | EHR_BASE_URL: ${process.env.EHR_BASE_URL}`);

    // Record trigger start in DB
    dbService.upsertEhrTriggerLog(jobKey, punchTypeCode, triggeredAt, 'Running')
        .catch(e => log.error(`upsertEhrTriggerLog (Running) failed: ${e.message}`));

    let records = [];
    const processedIds = new Set();

    try {
        log.info(`Fetching Pending/Failed ${label} records from ehr_punch_log…`);
        records = await dbService.getPendingPunchLogs(punchTypeCode);
        log.info(`Found ${records.length} record(s) to push`);

        if (!records.length) {
            log.warn(`No Pending ${label} records — nothing to push to EHR.`);
            dbService.upsertEhrTriggerLog(jobKey, punchTypeCode, triggeredAt, 'Completed', new Date())
                .catch(e => log.error(`upsertEhrTriggerLog (Completed) failed: ${e.message}`));
            return;
        }

        records.forEach((r, i) =>
            log.info(`  [${i + 1}/${records.length}] Id:${r.Id} | Emp:${r.EmployeeId} | PunchTime:${r.PunchTime} | Status:${r.PushStatus}`)
        );

        log.info(`Pushing ${records.length} ${label} record(s) to EHR API…`);
        const { results } = await ehrService.pushAttendanceToEhr(records);

        const succeededIds = [];
        const failedIds    = [];

        for (let i = 0; i < results.length; i++) {
            const r   = results[i];
            const rec = records[i];
            if (r.success) {
                succeededIds.push(rec.Id);
                log.info(`  Pushed  — Id: ${rec.Id} | Employee: ${rec.EmployeeId ?? 'N/A'}`);
            } else {
                failedIds.push(rec.Id);
                log.error(`  FAILED  — Id: ${rec.Id} | HTTP ${r.status ?? 'N/A'} | ${JSON.stringify(r.error)}`);
            }
        }

        if (succeededIds.length) {
            try {
                await dbService.updatePunchLogStatusByIds(succeededIds, 'Pushed');
                succeededIds.forEach(id => processedIds.add(id));
                log.ok(`  DB updated → Pushed for ${succeededIds.length} record(s)`);
            } catch (dbErr) {
                log.error(`  DB update FAILED for ${succeededIds.length} Pushed record(s) — they remain Pending for retry: ${dbErr.message}`);
            }
        }
        if (failedIds.length) {
            try {
                await dbService.updatePunchLogStatusByIds(failedIds, 'Failed');
                failedIds.forEach(id => processedIds.add(id));
                log.error(`  DB updated → Failed for ${failedIds.length} record(s)`);
            } catch (dbErr) {
                log.error(`  DB update FAILED for ${failedIds.length} Failed record(s): ${dbErr.message}`);
            }
        }

        const finalStatus = failedIds.length > 0 ? 'CompletedWithErrors' : 'Completed';
        dbService.upsertEhrTriggerLog(jobKey, punchTypeCode, triggeredAt, finalStatus, new Date())
            .catch(e => log.error(`upsertEhrTriggerLog (${finalStatus}) failed: ${e.message}`));

        log.ok(
            `EHR ${label} Push COMPLETE — ` +
            `Pushed: ${succeededIds.length}, Failed: ${failedIds.length} | ` +
            `elapsed: ${elapsed(startTime)}`
        );

    } catch (err) {
        log.error(`EHR ${label} Push unhandled error after ${elapsed(startTime)}: ${err.message}`);
        log.error(err.stack);
        dbService.upsertEhrTriggerLog(jobKey, punchTypeCode, triggeredAt, 'Failed', new Date())
            .catch(e => log.error(`upsertEhrTriggerLog (Failed) failed: ${e.message}`));
        const unprocessedIds = records.map(r => r.Id).filter(id => !processedIds.has(id));
        if (unprocessedIds.length) {
            await dbService.updatePunchLogStatusByIds(unprocessedIds, 'Failed')
                .catch(dbErr => log.error(`Failed to mark records as Failed in DB: ${dbErr.message}`));
            log.error(`  DB updated → Failed for ${unprocessedIds.length} unprocessed record(s) due to unhandled error`);
        }
    } finally {
        setGuard(false);
        log.banner(`EHR ${label.toUpperCase()} PUSH END`);
    }
}


function scheduleDaily(hour, minute, label, callback) {
    const hh   = String(hour).padStart(2, '0');
    const mm   = String(minute).padStart(2, '0');
    const expr = `${minute} ${hour} * * *`;

    // Validate the expression before registering
    if (!cron.validate(expr)) {
        log.error(`[REGISTRATION FAILED] Invalid cron expression "${expr}" for job "${label}"`);
        return;
    }

    log.info(`[REGISTERING] "${label}" | cron: "${expr}" | timezone: ${TIMEZONE} | time: ${hh}:${mm} IST`);

    cron.schedule(expr, async () => {
        const fireTime = Date.now();
        log.info(`━━━ CRON TRIGGERED ━━━ "${label}" | IST: ${istTs()}`);

        try {
            await callback();
        } catch (err) {
            log.error(`Unhandled error in scheduled job "${label}": ${err.message}`);
            log.error(err.stack);
        } finally {
            log.info(`━━━ CRON FINISHED  ━━━ "${label}" | elapsed: ${elapsed(fireTime)}`);
        }
    }, { timezone: TIMEZONE });

    log.ok(`[REGISTERED]  "${label}" — will fire daily at ${hh}:${mm} IST (cron: "${expr}")`);
}

function scheduleCron(expr, label, callback) {
    if (!cron.validate(expr)) {
        log.error(`[REGISTRATION FAILED] Invalid cron expression "${expr}" for job "${label}"`);
        return;
    }

    log.info(`[REGISTERING] "${label}" | cron: "${expr}" | timezone: ${TIMEZONE}`);

    cron.schedule(expr, async () => {
        const fireTime = Date.now();
        log.info(`━━━ CRON TRIGGERED ━━━ "${label}" | IST: ${istTs()}`);

        try {
            await callback();
        } catch (err) {
            log.error(`Unhandled error in scheduled job "${label}": ${err.message}`);
            log.error(err.stack);
        } finally {
            log.info(`━━━ CRON FINISHED  ━━━ "${label}" | elapsed: ${elapsed(fireTime)}`);
        }
    }, { timezone: TIMEZONE });

    log.ok(`[REGISTERED]  "${label}" — cron: "${expr}" (timezone: ${TIMEZONE})`);
}

function scheduleInterval(intervalMinutes, label, callback) {
    const intervalMs = intervalMinutes * 60 * 1000;

    log.info(`[REGISTERING] "${label}" | interval: every ${intervalMinutes} min`);

    const run = async () => {
        const fireTime = Date.now();
        log.info(`━━━ INTERVAL TRIGGERED ━━━ "${label}" | IST: ${istTs()}`);
        try {
            await callback();
        } catch (err) {
            log.error(`Unhandled error in interval job "${label}": ${err.message}`);
            log.error(err.stack);
        } finally {
            log.info(`━━━ INTERVAL FINISHED  ━━━ "${label}" | elapsed: ${elapsed(fireTime)}`);
        }
    };

    // Fire immediately on startup, then repeat every intervalMs
    run();
    setInterval(run, intervalMs);

    log.ok(`[REGISTERED]  "${label}" — fires every ${intervalMinutes} minutes (first run: immediate)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// startCronJobs — called once from index.js inside app.listen() callback
// ─────────────────────────────────────────────────────────────────────────────

function startCronJobs() {
    log.banner('CRON SCHEDULER INITIALIZING');

    // ── Environment diagnostic ───────────────────────────────────────────────
    const serverTz     = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nowUtc       = new Date().toISOString();
    const nowIst       = new Date().toLocaleString('en-IN', { timeZone: TIMEZONE, hour12: false });
    const nodeVersion  = process.version;
    const pid          = process.pid;

    log.info(`Node.js version  : ${nodeVersion}`);
    log.info(`Process PID      : ${pid}`);
    log.info(`Server timezone  : ${serverTz}`);
    log.info(`Current time UTC : ${nowUtc}`);
    log.info(`Current time IST : ${nowIst}`);
    log.info(`Scheduled tz     : ${TIMEZONE}`);

    if (serverTz !== TIMEZONE) {
        log.warn(
            `Server timezone (${serverTz}) differs from scheduler timezone (${TIMEZONE}). ` +
            `All scheduleDaily() times are evaluated in ${TIMEZONE} — this is correct ` +
            `because node-cron is given an explicit timezone option.`
        );
    }
    // ── Job registration ─────────────────────────────────────────────────────
    log.info('Registering daily cron jobs…');

    scheduleCron('0 */5 * * *', 'Stock Inventory Sync (every 5 hours)',
        async () => { await runStockInventoryApiSync(); }
    );

    scheduleDaily(0, 30, 'Product API Sync (12:30 AM IST)',
        async () => { await runProductApiSync(); }
    );

    scheduleDaily(1, 0, 'Price List API Sync (01:00 AM IST)',
        async () => { await runPriceListApiSync(); }
    );

    scheduleDaily(2, 0, 'Business Partner API Sync (02:00 AM IST)',
        async () => { await runBusinessPartnerApiSync(); }
    );

    scheduleDaily(5, 0, 'Attendance Check-Out Sync (5:0 AM IST)',
        async () => { await runAttendanceSync('Check-Out', 'O'); }
    );

    scheduleDaily(11,  0, 'Attendance Check-In Sync (11:00 AM IST)',
        async () => { await runAttendanceSync('Check-In',  'I'); }
    );

    // scheduleDaily(11,  15, 'Attendance Check-In Sync (11:15 AM IST)',
    //     async () => { await runEhrPushSync('I') }
    // );

    scheduleDaily(14,  0, 'Attendance Check-In Sync (2:00 PM IST)',
        async () => { await runAttendanceSync('Check-In',  'I'); }
    );

    // scheduleDaily(14,  15, 'Attendance Check-In Sync (2:00 PM IST)',
    //     async () => { await runEhrPushSync('I') }
    // );

    scheduleDaily(23, 30, 'Attendance Check-Out Sync (11:30 PM IST)',
        async () => { await runAttendanceSync('Check-Out', 'O'); }
    );

    // scheduleDaily(23, 40, 'Attendance Check-Out Sync (11:30 PM IST)',
    //     async () => { await runEhrPushSync('O'); }
    // );

    log.banner('CRON SCHEDULER READY');
}

// ─────────────────────────────────────────────────────────────────────────────
// Global safety net — log unhandled rejections so no silent job failures
// ─────────────────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
    log.error('Unhandled Promise Rejection detected:');
    log.error(`  Reason  : ${reason instanceof Error ? reason.message : String(reason)}`);
    if (reason instanceof Error) log.error(reason.stack);
});

process.on('uncaughtException', (err) => {
    log.error(`Uncaught Exception: ${err.message}`);
    log.error(err.stack);
});

module.exports = { startCronJobs, runAttendanceSync, runEhrPushSync, runStockInventoryApiSync, runProductApiSync, runPriceListApiSync, runBusinessPartnerApiSync };
