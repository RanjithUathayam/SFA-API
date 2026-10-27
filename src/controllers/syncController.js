const dbService = require('../services/dbService');
const sfService = require('../services/sfService');
const mapper    = require('../utils/dataMapper');
const recordPushSvc = require('../services/recordPushService');
const { json } = require('express');

// ─────────────────────────────────────────────────────────────────────────────
// Persistent last-sync timestamp (survives across API calls within one process)
// For production, persist this to a DB or file instead.
// ─────────────────────────────────────────────────────────────────────────────
let lastProductSync = new Date('2024-01-01');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function ts()          { return new Date().toISOString().replace('T', ' ').slice(0, 23); }
function elapsed(t)    { return `${((Date.now() - t) / 1000).toFixed(2)}s`; }
function divider(l='') { console.log(`[${ts()}] ${'─'.repeat(20)} ${l} ${'─'.repeat(20)}`); }
const log = {
    info  : (...a) => console.log (`[${ts()}] ℹ️ `, ...a),
    ok    : (...a) => console.log (`[${ts()}] ✅`, ...a),
    warn  : (...a) => console.warn(`[${ts()}] ⚠️ `, ...a),
    error : (...a) => console.error(`[${ts()}] ❌`, ...a),
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/products
// ─────────────────────────────────────────────────────────────────────────────
exports.syncProducts = async (req, res) => {
    const startTime = Date.now();
    divider('PRODUCT SYNC START');

    const codes    = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean) : [];
    const selective = codes.length > 0;

    let offset = 0;
    const PAGE_SIZE = parseInt(process.env.DB_PAGE_SIZE, 10) || 500;

    const summary = {
        totalDbRows   : 0,
        totalMapped   : 0,
        totalSuccess  : 0,
        totalFailed   : 0,
        failedProducts: [],
        pages         : 0
    };

    try {
        if (selective) {
            log.info(`Selective sync requested for ${codes.length} product code(s)`);
            summary.pages = 1;

            const rows = await dbService.getProductDataByCodes(codes);
            summary.totalDbRows = rows.length;
            log.info(`Fetched ${rows.length} DB row(s) for ${codes.length} requested code(s)`);

            const payload = mapper.mapToSalesforcePayload(rows);
            summary.totalMapped = payload.length;
            log.info(`Mapped to ${payload.length} product payload(s)`);

            if (payload.length > 0) {
                const results = await sfService.upsertProducts(payload);
                summary.totalSuccess = results.success.length;
                summary.totalFailed  = results.failed.length;
                if (results.failed.length > 0) {
                    summary.failedProducts.push(...results.failed.map(f => f.code));
                }
            }
        } else {
            log.info(`Last sync timestamp : ${lastProductSync.toISOString()}`);
            while (true) {
                summary.pages++;
                log.info(`── Page ${summary.pages} | DB offset: ${offset} | limit: ${PAGE_SIZE}`);

                const rows = await dbService.getProductData(lastProductSync, offset, PAGE_SIZE);

                if (rows.length === 0) {
                    log.info(`No more rows at offset ${offset}. Pagination complete.`);
                    break;
                }

                summary.totalDbRows += rows.length;
                log.info(`Fetched ${rows.length} DB row(s) (running total: ${summary.totalDbRows})`);

                const payload = mapper.mapToSalesforcePayload(rows);
                summary.totalMapped += payload.length;
                log.info(`Mapped to ${payload.length} product payload(s) (running total: ${summary.totalMapped})`);

                if (payload.length > 0) {
                    const results = await sfService.upsertProducts(payload);
                    summary.totalSuccess += results.success.length;
                    summary.totalFailed  += results.failed.length;
                    if (results.failed.length > 0) {
                        summary.failedProducts.push(...results.failed.map(f => f.code));
                    }
                }

                if (rows.length < PAGE_SIZE) break;
                offset += PAGE_SIZE;
            }

            lastProductSync = new Date();
        }

        divider('PRODUCT SYNC COMPLETE');
        log.ok (`Elapsed          : ${elapsed(startTime)}`);
        log.info(`Pages fetched    : ${summary.pages}`);
        log.info(`Total DB rows    : ${summary.totalDbRows}`);
        log.ok  (`SF success       : ${summary.totalSuccess}`);
        if (summary.totalFailed > 0) {
            log.error(`SF failed        : ${summary.totalFailed}`);
            log.warn (`Failed codes     : ${summary.failedProducts.join(', ')}`);
        }
        divider();

        return res.status(200).json({
            message       : summary.totalFailed === 0
                ? 'Product Sync Completed Successfully'
                : 'Product Sync Completed with some failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : {}),
            pages         : summary.pages,
            totalDbRows   : summary.totalDbRows,
            totalMapped   : summary.totalMapped,
            totalSuccess  : summary.totalSuccess,
            totalFailed   : summary.totalFailed,
            failedProducts: summary.failedProducts
        });

    } catch (err) {
        divider('PRODUCT SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Product Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/productTrigger
//
// Product Scheduler — processes every pending OITM row one item at a time:
//   1. Pull the pending OITM queue once: U_SFAItemActiveStatus = 'Yes' and
//      U_SFATriggerStatus <> 'Y', or U_SFAItemActiveStatus = 'No' and
//      U_SFATriggerStatus = 'N'.
//   2. Sync that single ItemCode to Salesforce.
//   3. Only on confirmed success, flip U_SFATriggerStatus to 'Y'.
//   4. Move on to the next item — a failed / not-found item never blocks the
//      loop; it is left pending so the next scheduler run retries it.
// ─────────────────────────────────────────────────────────────────────────────
async function syncSingleTriggeredProduct(ItemCode, ItemName) {
    const rows = await dbService.getProductDataByCodes([ItemCode]);
    if (!rows.length) {
        log.warn(`ItemCode ${ItemCode} not found in product master — skipped, left pending for retry.`);
        return { itemCode: ItemCode, itemName: ItemName, status: 'skipped', reason: 'Item not found in product master' };
    }

    const payload = mapper.mapToSalesforcePayload(rows);
    if (!payload.length) {
        log.warn(`Mapper produced 0 records for ${ItemCode} — skipped, left pending for retry.`);
        return { itemCode: ItemCode, itemName: ItemName, status: 'skipped', reason: 'Mapper produced no payload' };
    }

    const results   = await sfService.upsertProducts(payload);
    const succeeded = results.failed.length === 0 && results.success.length > 0;

    if (!succeeded) {
        log.error(`ItemCode ${ItemCode} sync did not fully succeed — left pending for retry.`);
        return { itemCode: ItemCode, itemName: ItemName, status: 'failed', reason: 'Salesforce upsert failed', failed: results.failed };
    }

    await dbService.markProductTriggerSynced(ItemCode);
    log.ok(`ItemCode ${ItemCode} synced successfully — U_SFATriggerStatus set to 'Y'.`);
    return { itemCode: ItemCode, itemName: ItemName, status: 'success' };
}

exports.syncNextTriggeredProduct = async (req, res) => {
    const startTime = Date.now();
    divider('PRODUCT TRIGGER SYNC START');

    const summary = { processed: 0, success: 0, skipped: 0, failed: 0, items: [] };

    try {
        const triggers = await dbService.getPendingProductTriggers();
        log.info(`Pending items in queue : ${triggers.length}`);

        for (const { ItemCode, ItemName } of triggers) {
            summary.processed++;
            log.info(`[${summary.processed}] Pending item found : ${ItemCode} (${ItemName})`);

            let result;
            try {
                result = await syncSingleTriggeredProduct(ItemCode, ItemName);
            } catch (itemErr) {
                log.error(`ItemCode ${ItemCode} sync threw: ${itemErr.message} — left pending for retry.`);
                result = { itemCode: ItemCode, itemName: ItemName, status: 'failed', reason: itemErr.message };
            }

            summary[result.status]++;
            if (result.status !== 'success') summary.items.push(result);
        }

        divider('PRODUCT TRIGGER SYNC COMPLETE');
        log.ok  (`Elapsed   : ${elapsed(startTime)}`);
        log.info(`Processed : ${summary.processed}`);
        log.ok  (`Success   : ${summary.success}`);
        if (summary.skipped) log.warn (`Skipped   : ${summary.skipped}`);
        if (summary.failed)  log.error(`Failed    : ${summary.failed}`);
        divider();

        if (summary.processed === 0) {
            log.info('No pending OITM trigger rows (active, U_SFATriggerStatus <> \'Y\') — nothing to sync.');
            return res.status(200).json({ message: 'No pending items to sync.' });
        }

        return res.status(200).json({
            message       : summary.skipped + summary.failed === 0
                ? 'Product Trigger Sync Completed Successfully'
                : 'Product Trigger Sync Completed — some items left pending for retry',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            processed     : summary.processed,
            success       : summary.success,
            skipped       : summary.skipped,
            failed        : summary.failed,
            pendingItems  : summary.items
        });

    } catch (err) {
        divider('PRODUCT TRIGGER SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Product Trigger Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            processed     : summary.processed,
            success       : summary.success,
            skipped       : summary.skipped,
            failed        : summary.failed,
            error         : err.message
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/pricelists
// ─────────────────────────────────────────────────────────────────────────────
exports.syncPriceLists = async (req, res) => {
    const startTime = Date.now();
    divider('PRICELIST SYNC START');

    const codes     = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean) : [];
    const selective = codes.length > 0;

    try {
        log.info(selective
            ? `Selective sync requested for ${codes.length} product code(s)`
            : 'Fetching price list data from DB…');
        const sqlData = selective
            ? await dbService.getPriceListDataByCodes(codes)
            : await dbService.getPriceListData();

        if (!sqlData.length) {
            log.warn('No price data found in DB.');
            return res.status(200).json({ message: 'No price data found.' });
        }

        log.info(`Fetched ${sqlData.length} raw DB row(s)`);
        
        const payload = mapper.mapToPriceListPayload(sqlData);
        
        if (!payload.length) {
            log.warn('Mapper produced 0 records — nothing to sync.');
            return res.status(200).json({ message: 'No valid price data to sync.' });
        }

        log.info(`Mapped to ${payload.length} product price record(s)`);
        payload.slice(0, 3).forEach((p, i) =>
            log.info(`  [${i + 1}] ${p.ProductCode} → ${p.PriceList?.length ?? 0} pricelist(s)`)
        );
        const sfResult = await sfService.upsertPriceLists(payload);
        divider('PRICELIST SYNC COMPLETE');
        log.ok(`Elapsed : ${elapsed(startTime)}`);
        divider();
        
        return res.status(200).json({
            message       : sfResult.failedBatches === 0
                ? 'PriceList Sync Completed Successfully'
                : 'PriceList Sync Completed with some batch failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : {}),
            dbRowsFetched : sqlData.length,
            recordsSent   : payload.length,
            ...sfResult
        });

    } catch (err) {
        divider('PRICELIST SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'PriceList Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/images
// ─────────────────────────────────────────────────────────────────────────────
exports.syncImages = async (req, res) => {
    const startTime = Date.now();
    divider('IMAGE SYNC START');

    try {
        log.info('Fetching image data from DB…');
        const sqlData = await dbService.getImageData();
        log.info(`Fetched ${sqlData.length} image entry(ies) from DB`);

        if (!sqlData.length) {
            log.warn('No image data found in DB.');
            return res.json({ message: 'No image data to sync.' });
        }

        const payload = mapper.mapToImagePayload(sqlData);
        log.info(`Mapped to ${payload.length} image payload(s)`);

        if (payload.length === 0) {
            log.warn('Mapper produced 0 payloads — nothing to upload.');
            return res.json({ message: 'No image data to sync.' });
        }

        const sfResult = await sfService.uploadImages(payload);

        divider('IMAGE SYNC COMPLETE');
        log.ok(`Elapsed : ${elapsed(startTime)}`);
        divider();

        return res.status(200).json({
            message       : sfResult.failedBatches === 0
                ? 'Image Sync Completed Successfully'
                : 'Image Sync Completed with some batch failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            dbRowsFetched : sqlData.length,
            imagesSent    : payload.length,
            ...sfResult
        });

    } catch (err) {
        divider('IMAGE SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Image Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/schemes
// ─────────────────────────────────────────────────────────────────────────────
exports.syncSchemes = async (req, res) => {
    const startTime = Date.now();
    divider('SCHEME SYNC START');

    const codes     = Array.isArray(req.body?.codes) ? req.body.codes.filter(v => v !== null && v !== undefined && v !== '') : [];
    const selective = codes.length > 0;

    try {
        log.info(selective
            ? `Selective sync requested for ${codes.length} scheme DocEntry(ies)`
            : 'Fetching scheme data from DB…');
        const sqlData = selective
            ? await dbService.getSchemeDataByCodes(codes)
            : await dbService.getSchemeData();
        log.info(`Fetched ${sqlData.length} raw DB row(s)`);

        if (!sqlData.length) {
            log.warn('No scheme data found in DB.');
            return res.status(200).json({ message: 'No scheme data found.' });
        }

        const payload = mapper.mapToSchemePayload(sqlData);
        log.info(`Mapped to ${payload.length} scheme(s)`);

        if (!payload.length) {
            log.warn('Mapper produced 0 schemes — nothing to sync.');
            return res.status(200).json({ message: 'No valid scheme data to sync.' });
        }

        payload.slice(0, 3).forEach((s, i) =>
            log.info(
                `  [${i + 1}] ${s.Policy.PolicyNumber} | ` +
                `${s.Policy.SC_ProductMapping.length} product line(s) | ` +
                `State: ${s.Policy.StateMapping[0]?.StateCode ?? 'n/a'} | ` +
                `BP: ${s.Policy.SC_BpInclution[0]?.BPCode ?? 'n/a'}`
            )
        );

        const sfResult = await sfService.upsertSchemes(payload);

        divider('SCHEME SYNC COMPLETE');
        log.ok (`Elapsed          : ${elapsed(startTime)}`);
        log.info(`DB rows fetched  : ${sqlData.length}`);
        log.info(`Schemes mapped   : ${payload.length}`);
        log.ok  (`SF success       : ${sfResult.successCount}`);
        if (sfResult.failedCount > 0) {
            log.error(`SF failed        : ${sfResult.failedCount}`);
        }
        divider();

        return res.status(200).json({
            message       : sfResult.failedCount === 0
                ? 'Scheme Sync Completed Successfully'
                : 'Scheme Sync Completed with some failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : {}),
            dbRowsFetched : sqlData.length,
            schemesMapped : payload.length,
            ...sfResult
        });

    } catch (err) {
        divider('SCHEME SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Scheme Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/businesspartners
//
// Flow:
//   1. Run BP Master query via dbService
//   2. Map rows → { businessPartners: [...] } via mapper
//   3. Send to SF one BP at a time (SF limit: max 1 BP per request)
// ─────────────────────────────────────────────────────────────────────────────
exports.syncBusinessPartners = async (req, res) => {
    const startTime = Date.now();
    divider('BP SYNC START');

    const codes     = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean) : [];
    const selective = codes.length > 0;

    try {
        log.info(selective
            ? `Selective sync requested for ${codes.length} BP code(s)`
            : 'Fetching BP master data from DB…');
        const sqlData = selective
            ? await dbService.getBPMasterDataByCodes(codes)
            : await dbService.getBPMasterData();
        log.info(`Fetched ${sqlData.length} raw DB row(s) across all sub-brand passes`);

        if (!sqlData.length) {
            log.warn('No BP data found in DB.');
            return res.status(200).json({ message: 'No BP data found.' });
        }
        const payload  = mapper.mapToBPPayload(sqlData);
        const totalBPs = payload.businessPartners.length;
        log.info(`Mapped to ${totalBPs} unique business partner(s)`);

        if (totalBPs === 0) {
            log.warn('Mapper produced 0 BPs — nothing to sync.');
            return res.status(200).json({ message: 'No valid BP data to sync.' });
        }

        // Log a sample of the first 3 BPs
        payload.businessPartners.slice(0, 3).forEach((bp, i) =>
            log.info(
                `  [${i + 1}] ${bp.BPCode} | ${bp.BPName} | ` +
                `Category: ${bp.BPCategory} | ` +
                `Addresses: ${bp.BillShipTo.length} | ` +
                `SubBrands: ${bp.MST_Map_BP_SubBrand.length}`
            )
        );
        
        const sfResult = await sfService.upsertBusinessPartners(payload);

        divider('BP SYNC COMPLETE');
        log.ok (`Elapsed          : ${elapsed(startTime)}`);
        log.info(`DB rows fetched  : ${sqlData.length}`);
        log.info(`BPs mapped       : ${totalBPs}`);
        log.ok  (`SF success       : ${sfResult.successRecords}`);
        if (sfResult.failedRecords > 0) {
            log.error(`SF failed        : ${sfResult.failedRecords}`);
        }
        divider();

        return res.status(200).json({
            message       : sfResult.failedRecords === 0
                ? 'Business Partner Sync Completed Successfully'
                : 'Business Partner Sync Completed with some failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : {}),
            dbRowsFetched : sqlData.length,
            bpsMapped     : totalBPs,
            ...sfResult
        });

    } catch (err) {
        divider('BP SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Business Partner Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/businessPartnerTrigger  (also run nightly by
// cronJobs.runBusinessPartnerApiSync)
//
// Business Partner Scheduler — same flow as syncBusinessPartners, limited to
// OCRD rows flagged pending (U_SFATriggerStatus = 'N'):
//   1. Fetch ALL pending CardCodes (active customers with an area code)
//   2. Run BP Master query for those codes via dbService
//   3. Map rows → { businessPartners: [...] } via mapper
//   4. Send to SF one BP at a time (SF limit: max 1 BP per request)
//   5. Set U_SFATriggerStatus = 'Y' only for BPs SF accepted — failed /
//      not-found BPs stay 'N' and are retried next run.
//   6. Record each BP's result (Pushed / Failed + error) in
//      SFA_RecordPushStatus (MasterType='businesspartners').
// NULL U_SFATriggerStatus = legacy BP never flagged by SAP — not pending; use
// POST /api/sync/businesspartners for a full / selective push.
// ─────────────────────────────────────────────────────────────────────────────
let bpTriggerSyncRunning = false;

// Status-table writes must never break the trigger flow — log and carry on.
async function recordBPPushResults(results) {
    if (!results.length) return;
    try {
        await recordPushSvc.ensureTable();
        await recordPushSvc.setBulkResults('businesspartners', results);
    } catch (err) {
        log.error(`Could not record BP push status for ${results.length} BP(s): ${err.message}`);
    }
}

// SF BP API error body: { status, message, results: [{ externalId, errors: [...] }] }
// → keep just the per-record error lines; fall back to raw JSON.
function errorText(e) {
    if (typeof e === 'string') return e;
    const lines = (e?.results || []).flatMap(r => r.errors?.length ? r.errors : [r.message]).filter(Boolean);
    return lines.length ? lines.join(' | ') : JSON.stringify(e);
}

exports.syncNextTriggeredBusinessPartner = async (req, res) => {
    // One run at a time across the cron job and the HTTP endpoint, so the same
    // pending BP is never pushed to SF twice concurrently.
    if (bpTriggerSyncRunning) {
        const msg = 'Business Partner trigger sync is already running. Try again when it finishes.';
        log.warn(msg);
        return res.status(409).json({ message: msg, error: msg });
    }
    bpTriggerSyncRunning = true;

    const startTime = Date.now();
    divider('BP TRIGGER SYNC START');

    let mappedCodes = [];
    try {
        log.info('Fetching pending business partners (OCRD.U_SFATriggerStatus = \'N\')…');
        const triggers = await dbService.getAllPendingBPTriggers();
        const codes    = triggers.map(t => t.CardCode);
        log.info(`Pending business partners found : ${codes.length}`);
        triggers.forEach((t, i) => log.info(`  [${i + 1}/${codes.length}] ${t.CardCode} | ${t.CardName}`));

        if (!codes.length) {
            log.info('No pending OCRD trigger rows (U_SFATriggerStatus = \'N\') — nothing to sync.');
            return res.status(200).json({ message: 'No pending business partners to sync.' });
        }

        const sqlData = await dbService.getBPMasterDataByCodes(codes);
        log.info(`Fetched ${sqlData.length} raw DB row(s) across all sub-brand passes`);

        if (!sqlData.length) {
            log.warn(`No BP data found in DB for pending codes — left pending: ${codes.join(', ')}`);
            await recordBPPushResults(codes.map(c => ({ recordKey: c, success: false, errorMessage: 'Not found in BP master' })));
            return res.status(200).json({ message: 'No BP data found.', pendingCount: codes.length, notFound: codes });
        }

        const payload  = mapper.mapToBPPayload(sqlData);
        const totalBPs = payload.businessPartners.length;
        log.info(`Mapped to ${totalBPs} unique business partner(s)`);

        if (totalBPs === 0) {
            log.warn('Mapper produced 0 BPs — nothing to sync.');
            await recordBPPushResults(codes.map(c => ({ recordKey: c, success: false, errorMessage: 'Mapper produced no payload' })));
            return res.status(200).json({ message: 'No valid BP data to sync.', pendingCount: codes.length });
        }

        mappedCodes    = payload.businessPartners.map(bp => bp.BPCode);
        const notFound = codes.filter(c => !mappedCodes.includes(c));
        if (notFound.length) {
            log.warn(`Not found in BP master (skipped, left pending): ${notFound.join(', ')}`);
            await recordBPPushResults(notFound.map(c => ({ recordKey: c, success: false, errorMessage: 'Not found in BP master' })));
        }

        payload.businessPartners.forEach((bp, i) =>
            log.info(
                `  Payload [${i + 1}/${totalBPs}] ${bp.BPCode} | ${bp.BPName} | ` +
                `Category: ${bp.BPCategory} | ` +
                `Addresses: ${bp.BillShipTo.length} | ` +
                `Contacts: ${bp.Map_BpContactDetails.length} | ` +
                `SubBrands: ${bp.MST_Map_BP_SubBrand.length}`
            )
        );

        log.info(`Calling SF BusinessPartner API for ${totalBPs} BP(s)…`);
        const sfResult = await sfService.upsertBusinessPartners(payload);
        log.info(`SF response — success: ${sfResult.successRecords}, failed: ${sfResult.failedRecords}`);

        const failedByCode = new Map((sfResult.failedDetails || []).map(f => [f.code, f]));
        const syncedCodes  = mappedCodes.filter(c => !failedByCode.has(c));

        syncedCodes.forEach(c => log.ok(`  ${c} — SF accepted`));
        failedByCode.forEach((f, c) =>
            log.error(`  ${c} — SF FAILED (HTTP ${f.status}) — left pending: ${errorText(f.error)}`)
        );

        // SF already accepted these — any BP whose 'Y' update fails (e.g. row
        // locked by SAP) stays 'N' and is re-upserted next run.
        let updated = 0;
        let markError = null;
        if (syncedCodes.length) {
            try {
                const mark = await dbService.markBPTriggersSynced(syncedCodes);
                updated = mark.updated;
                const markFailed = new Set(mark.failed.map(f => f.code));
                const marked     = syncedCodes.filter(c => !markFailed.has(c));
                if (marked.length) log.ok(`U_SFATriggerStatus set to 'Y' for ${updated} BP(s): ${marked.join(', ')}`);
                mark.failed.forEach(f =>
                    log.error(`  ${f.code} — could not set U_SFATriggerStatus = 'Y' (left pending): ${f.error}`)
                );
                if (mark.failed.length) {
                    markError = `Could not set 'Y' for ${mark.failed.length} BP(s): ${mark.failed.map(f => f.code).join(', ')}`;
                }
            } catch (dbErr) {
                markError = dbErr.message;
                log.error(`Failed to set U_SFATriggerStatus = 'Y' for ${syncedCodes.length} BP(s) — left pending: ${dbErr.message}`);
            }
        }

        await recordBPPushResults([
            ...syncedCodes.map(c => ({ recordKey: c, success: true, errorMessage: null })),
            ...[...failedByCode].map(([c, f]) => ({ recordKey: c, success: false, errorMessage: errorText(f.error) })),
        ]);

        divider('BP TRIGGER SYNC COMPLETE');
        log.ok  (`Elapsed          : ${elapsed(startTime)}`);
        log.info(`Pending found    : ${codes.length}`);
        log.info(`BPs mapped       : ${totalBPs}`);
        log.ok  (`SF success       : ${sfResult.successRecords}`);
        log.ok  (`Marked 'Y'       : ${updated}`);
        if (sfResult.failedRecords > 0) log.error(`SF failed        : ${sfResult.failedRecords}`);
        if (notFound.length)            log.warn (`Not found        : ${notFound.length}`);
        if (markError)                  log.error(`Trigger update   : FAILED — ${markError}`);
        divider();

        return res.status(200).json({
            message       : sfResult.failedRecords === 0 && notFound.length === 0 && !markError
                ? 'Business Partner Trigger Sync Completed Successfully'
                : 'Business Partner Trigger Sync Completed — some business partners left pending for retry',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            pendingCount  : codes.length,
            dbRowsFetched : sqlData.length,
            bpsMapped     : totalBPs,
            markedSynced  : updated,
            ...(markError ? { markError } : {}),
            notFound,
            ...sfResult
        });

    } catch (err) {
        divider('BP TRIGGER SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        // sfService attaches per-BP errors when every upsert failed.
        const sfFailed = new Map((err.failedDetails || []).map(f => [f.code, f]));
        sfFailed.forEach((f, c) =>
            log.error(`  ${c} — SF FAILED (HTTP ${f.status}) — left pending: ${errorText(f.error)}`)
        );
        if (mappedCodes.length) {
            log.error(`Left pending (U_SFATriggerStatus stays 'N'): ${mappedCodes.join(', ')}`);
            await recordBPPushResults(mappedCodes.map(c => ({
                recordKey   : c,
                success     : false,
                errorMessage: sfFailed.has(c) ? errorText(sfFailed.get(c).error) : err.message,
            })));
        }
        divider();
        return res.status(500).json({
            message       : 'Business Partner Trigger Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            ...(sfFailed.size ? { failedDetails: err.failedDetails } : {}),
            details       : err.response?.data ?? null
        });
    } finally {
        bpTriggerSyncRunning = false;
    }
};

exports.syncStockInventory = async (req, res) => {
    const startTime = Date.now();
    divider('STOCK INVENTORY SYNC START');

    const codes     = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean) : [];
    const selective = codes.length > 0;

    try {
        log.info(selective
            ? `Selective sync requested for ${codes.length} item code(s)`
            : 'Fetching stock data from DB…');
        const sqlData = selective
            ? await dbService.getStockDataByCodes(codes)
            : await dbService.getStockData();
        log.info(`Fetched ${sqlData.length} raw DB row(s)`);
 
        if (!sqlData.length) {
            log.warn('No stock data found in DB.');
            return res.status(200).json({ message: 'No stock data found.' });
        }
 
        const payload = mapper.mapToStockPayload(sqlData);   // flat array
        log.info(`Mapped to ${payload.length} stock record(s)`);
 
        if (payload.length === 0) {
            log.warn('Mapper produced 0 records — nothing to sync.');
            return res.status(200).json({ message: 'No valid stock data to sync.' });
        }
 
        // Log a sample of the first 3 records
        payload.slice(0, 3).forEach((r, i) =>
            log.info(
                `  [${i + 1}] ProductCode: ${r.ProductCode} | ` +
                `Color: ${r.ColorCode} | Qty: ${r.StockQuantity} | ` +
                `Active: ${r.IsActive}`
            )
        );
        
        const sfResult = await sfService.upsertStockInventory(payload);
 
        divider('STOCK INVENTORY SYNC COMPLETE');
        log.ok (`Elapsed           : ${elapsed(startTime)}`);
        log.info(`DB rows fetched   : ${sqlData.length}`);
        log.info(`Records sent      : ${sfResult.totalRecords}`);
        log.ok  (`Success           : ${sfResult.successRecords}`);
        if (sfResult.failedRecords > 0) {
            log.error(`Failed            : ${sfResult.failedRecords}`);
        }
        divider();
 
        return res.status(200).json({
            message: sfResult.failedBatches === 0
                ? 'Stock Inventory Sync Completed Successfully'
                : 'Stock Inventory Sync Completed with some failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : {}),
            dbRowsFetched : sqlData.length,
            ...sfResult
        });
 
    } catch (err) {
        divider('STOCK INVENTORY SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Stock Inventory Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    }
};

exports.syncOutstanding = async (req, res) => {
    const startTime = Date.now();
    divider('OUTSTANDING SYNC START');

    const codes     = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean) : [];
    const selective = codes.length > 0;

    try {
        log.info(selective
            ? `Selective sync requested for ${codes.length} BP code(s)`
            : 'Fetching outstanding data from DB...');
        const sqlData = selective
            ? await dbService.getOutstandingDataByCodes(codes)
            : await dbService.getOutstandingData();
        log.info(`Fetched ${sqlData.length} raw DB row(s)`);

        if (!sqlData.length) {
            log.warn('No outstanding data found in DB.');
            return res.status(200).json({ message: 'No outstanding data found.' });
        }

        const payload = mapper.mapToOutstandingPayload(sqlData);
        log.info(`Mapped to ${payload.length} outstanding record(s)`);

        if (payload.length === 0) {
            log.warn('Mapper produced 0 records - nothing to sync.');
            return res.status(200).json({ message: 'No valid outstanding data to sync.' });
        }

        payload.slice(0, 3).forEach((row, i) =>
            log.info(
                `  [${i + 1}] ${row.CardCode} | ${row.DocType ?? 'n/a'} | ` +
                `Invoice: ${row.InvoiceNo ?? 'n/a'} | Balance: ${row.BalanceToBePaid ?? 0}`
            )
        );

        const sfResult = await sfService.upsertOutstanding(payload);

        divider('OUTSTANDING SYNC COMPLETE');
        log.ok (`Elapsed           : ${elapsed(startTime)}`);
        log.info(`DB rows fetched   : ${sqlData.length}`);
        log.info(`Records sent      : ${sfResult.totalRecords}`);
        log.ok  (`Success           : ${sfResult.successRecords}`);
        if (sfResult.failedRecords > 0) {
            log.error(`Failed            : ${sfResult.failedRecords}`);
        }
        divider();

        return res.status(200).json({
            message: sfResult.failedBatches === 0
                ? 'Outstanding Sync Completed Successfully'
                : 'Outstanding Sync Completed with some failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : {}),
            dbRowsFetched : sqlData.length,
            ...sfResult
        });

    } catch (err) {
        divider('OUTSTANDING SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Outstanding Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    }
};
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/invoice
// Body (all optional):
//   codes       : ["1065287", ...]  OINV.DocEntry — push exactly these (any date, any status)
//   fromDate    : "YYYY-MM-DD"      default SF_INVOICE_SYNC_FROM_DATE, else today (IST)
//   toDate      : "YYYY-MM-DD"      default SF_INVOICE_SYNC_TO_DATE,   else today (IST)
//   onlyPending : boolean           default true — skip invoices already Pushed
// Every result is recorded in SFA_RecordPushStatus (MasterType='invoice').
// ─────────────────────────────────────────────────────────────────────────────
let invoiceSyncRunning = false;

exports.syncInvoices = async (req, res) => {
    if (invoiceSyncRunning) {
        const msg = 'Invoice sync is already running. Try again when it finishes.';
        return res.status(409).json({ message: msg, error: msg });
    }
    invoiceSyncRunning = true;

    const startTime   = Date.now();
    const codes       = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean).map(String) : [];
    const selective   = codes.length > 0;
    const onlyPending = req.body?.onlyPending !== false;
    const window      = dbService.resolveInvoiceWindow({ fromDate: req.body?.fromDate, toDate: req.body?.toDate });
    divider('INVOICE SYNC START');

    try {
        await recordPushSvc.ensureTable();

        log.info(selective
            ? `Selective sync requested for ${codes.length} invoice(s)`
            : `Fetching invoices ${window.fromDate} → ${window.toDate} (${onlyPending ? 'pending/failed only' : 'all'})...`);
        const sqlData = selective
            ? await dbService.getInvoiceData({ docEntries: codes })
            : await dbService.getInvoiceData({ ...window, onlyPending });
        log.info(`Fetched ${sqlData.length} invoice(s)`);

        const base = {
            elapsedSeconds: 0,
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : { window, onlyPending }),
            dbRowsFetched : sqlData.length,
        };

        if (!sqlData.length) {
            log.warn('No invoices to sync.');
            return res.status(200).json({
                ...base,
                message: selective ? 'No invoices found for the selected records.' : 'No pending invoices to sync.',
                elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
                successRecords: 0, failedRecords: 0, failedDetails: [],
            });
        }

        const payload = mapper.mapToInvoicePayload(sqlData);
        payload.slice(0, 3).forEach((p, i) =>
            log.info(`  [${i + 1}] DocNum ${p.docNum} | ${p.invoice.Cardcode} | Lines: ${p.invoice.InvoiceDetail.length} | Total: ${p.invoice.DocTotal}`)
        );
        const sfResult = await sfService.upsertInvoices(payload, {
            onBatchResult: (keys, ok, error) => recordPushSvc.setBulkResults('invoice',
                keys.map(k => ({ recordKey: k, success: ok, errorMessage: error }))),
        });

        divider('INVOICE SYNC COMPLETE');
        log.ok  (`Elapsed           : ${elapsed(startTime)}`);
        log.info(`Invoices sent     : ${sfResult.totalRecords}`);
        log.ok  (`Success           : ${sfResult.successRecords}`);
        if (sfResult.failedRecords > 0) log.error(`Failed            : ${sfResult.failedRecords}`);
        divider();

        return res.status(200).json({
            ...base,
            message: sfResult.failedRecords === 0
                ? 'Invoice Sync Completed Successfully'
                : sfResult.successRecords === 0
                    ? 'Invoice Sync Failed for all invoices'
                    : 'Invoice Sync Completed with some failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            ...sfResult
        });

    } catch (err) {
        divider('INVOICE SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Invoice Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    } finally {
        invoiceSyncRunning = false;
    }
};
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/salereturn
// Body (all optional):
//   codes       : ["79599", ...]    ORIN.DocEntry — push exactly these (any date, any status)
//   fromDate    : "YYYY-MM-DD"      default SF_SALERETURN_SYNC_FROM_DATE, else today (IST)
//   toDate      : "YYYY-MM-DD"      default SF_SALERETURN_SYNC_TO_DATE,   else today (IST)
//   onlyPending : boolean           default true — skip returns already Pushed
// Every result is recorded in SFA_RecordPushStatus (MasterType='salereturn').
// ─────────────────────────────────────────────────────────────────────────────
let saleReturnSyncRunning = false;

exports.syncSaleReturns = async (req, res) => {
    if (saleReturnSyncRunning) {
        const msg = 'Sale return sync is already running. Try again when it finishes.';
        return res.status(409).json({ message: msg, error: msg });
    }
    saleReturnSyncRunning = true;

    const startTime   = Date.now();
    const codes       = Array.isArray(req.body?.codes) ? req.body.codes.filter(Boolean).map(String) : [];
    const selective   = codes.length > 0;
    const onlyPending = req.body?.onlyPending !== false;
    const window      = dbService.resolveSaleReturnWindow({ fromDate: req.body?.fromDate, toDate: req.body?.toDate });
    divider('SALE RETURN SYNC START');

    try {
        await recordPushSvc.ensureTable();

        log.info(selective
            ? `Selective sync requested for ${codes.length} sale return(s)`
            : `Fetching sale returns ${window.fromDate} → ${window.toDate} (${onlyPending ? 'pending/failed only' : 'all'})...`);
        const sqlData = selective
            ? await dbService.getSaleReturnData({ docEntries: codes })
            : await dbService.getSaleReturnData({ ...window, onlyPending });
        log.info(`Fetched ${sqlData.length} sale return(s)`);

        const base = {
            elapsedSeconds: 0,
            mode          : selective ? 'selected' : 'all',
            ...(selective ? { requestedCount: codes.length } : { window, onlyPending }),
            dbRowsFetched : sqlData.length,
        };

        if (!sqlData.length) {
            log.warn('No sale returns to sync.');
            return res.status(200).json({
                ...base,
                message: selective ? 'No sale returns found for the selected records.' : 'No pending sale returns to sync.',
                elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
                successRecords: 0, failedRecords: 0, failedDetails: [],
            });
        }

        const payload = mapper.mapToSaleReturnPayload(sqlData);
        payload.slice(0, 3).forEach((p, i) =>
            log.info(`  [${i + 1}] DocNum ${p.docNum} | ${p.saleReturn.cardCode} | Lines: ${p.saleReturn.SaleReturnDetails.length} | Total: ${p.saleReturn.totalAmount}`)
        );
        const sfResult = await sfService.upsertSaleReturns(payload, {
            onBatchResult: (keys, ok, error) => recordPushSvc.setBulkResults('salereturn',
                keys.map(k => ({ recordKey: k, success: ok, errorMessage: error }))),
        });

        divider('SALE RETURN SYNC COMPLETE');
        log.ok  (`Elapsed           : ${elapsed(startTime)}`);
        log.info(`Returns sent      : ${sfResult.totalRecords}`);
        log.ok  (`Success           : ${sfResult.successRecords}`);
        if (sfResult.failedRecords > 0) log.error(`Failed            : ${sfResult.failedRecords}`);
        divider();

        return res.status(200).json({
            ...base,
            message: sfResult.failedRecords === 0
                ? 'Sale Return Sync Completed Successfully'
                : sfResult.successRecords === 0
                    ? 'Sale Return Sync Failed for all returns'
                    : 'Sale Return Sync Completed with some failures',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            ...sfResult
        });

    } catch (err) {
        divider('SALE RETURN SYNC ERROR');
        log.error(`Sync failed after ${elapsed(startTime)}: ${err.message}`);
        divider();
        return res.status(500).json({
            message       : 'Sale Return Sync Failed',
            elapsedSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error         : err.message,
            details       : err.response?.data ?? null
        });
    } finally {
        saleReturnSyncRunning = false;
    }
};
