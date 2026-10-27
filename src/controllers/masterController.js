const dbService     = require('../services/dbService');
const sfService     = require('../services/sfService');
const mapper        = require('../utils/dataMapper');
const recordPushSvc = require('../services/recordPushService');

// Per-master config: how to fetch, map, push, and decode SF results
const MASTERS = {
    pricelists: {
        masterType:    'pricelists',
        recordKeyField: 'ProductCode',
        fetchPaged:    (opts)  => dbService.getPriceListsPaged(opts),
        fetchByCodes:  (codes) => dbService.getPriceListDataByCodes(codes),
        mapPayload:    (rows)  => mapper.mapToPriceListPayload(rows),
        sfPush:        (pl)    => sfService.upsertPriceLists(pl),
        // failedDetails: [{batch, codes:[ProductCode], error}]
        extractResults(sfResult, requestedKeys) {
            const failedMap = {};
            for (const f of (sfResult.failedDetails || [])) {
                const err = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
                for (const code of (f.codes || [])) failedMap[code] = err;
            }
            return {
                success: requestedKeys.filter(k => !failedMap[k]),
                failed:  Object.entries(failedMap).map(([k, e]) => ({ key: k, error: e })),
            };
        },
    },

    businesspartners: {
        masterType:    'businesspartners',
        recordKeyField: 'BPCode',
        fetchPaged:    (opts)  => dbService.getBPListPaged(opts),
        fetchByCodes:  (codes) => dbService.getBPMasterDataByCodes(codes),
        // mapToBPPayload returns { businessPartners:[...] } — normalize to array so the controller can check .length
        mapPayload:    (rows)  => (mapper.mapToBPPayload(rows).businessPartners || []),
        sfPush:        (bps)   => sfService.upsertBusinessPartners({ businessPartners: bps }),
        // failedDetails: [{code:BPCode, error}]
        extractResults(sfResult, requestedKeys) {
            const failedMap = {};
            for (const f of (sfResult.failedDetails || [])) {
                if (f.code) failedMap[f.code] = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
            }
            return {
                success: requestedKeys.filter(k => !failedMap[k]),
                failed:  Object.entries(failedMap).map(([k, e]) => ({ key: k, error: e })),
            };
        },
    },

    schemes: {
        masterType:    'schemes',
        recordKeyField: 'DocEntry',
        fetchPaged:    (opts)  => dbService.getSchemesPaged(opts),
        fetchByCodes:  (codes) => dbService.getSchemeDataByCodes(codes),
        mapPayload:    (rows)  => mapper.mapToSchemePayload(rows),
        sfPush:        (pl)    => sfService.upsertSchemes(pl),
        // failedDetails: [{policyNum, policyId:DocEntry, error}]
        extractResults(sfResult, requestedKeys) {
            const failedMap = {};
            for (const f of (sfResult.failedDetails || [])) {
                const k = String(f.policyId);
                if (k) failedMap[k] = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
            }
            return {
                success: requestedKeys.filter(k => !failedMap[String(k)]),
                failed:  Object.entries(failedMap).map(([k, e]) => ({ key: k, error: e })),
            };
        },
    },

    stockInventory: {
        masterType:    'stockInventory',
        recordKeyField: 'ProductCode',
        fetchPaged:    (opts)  => dbService.getStockPaged(opts),
        fetchByCodes:  (codes) => dbService.getStockDataByCodes(codes),
        mapPayload:    (rows)  => mapper.mapToStockPayload(rows),
        sfPush:        (pl)    => sfService.upsertStockInventory(pl),
        // failedDetails: [{batch, codes:[ItemCode], error}]
        extractResults(sfResult, requestedKeys) {
            const failedMap = {};
            for (const f of (sfResult.failedDetails || [])) {
                const err = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
                for (const code of (f.codes || [])) failedMap[code] = err;
            }
            return {
                success: requestedKeys.filter(k => !failedMap[k]),
                failed:  Object.entries(failedMap).map(([k, e]) => ({ key: k, error: e })),
            };
        },
    },

    outstanding: {
        masterType:    'outstanding',
        recordKeyField: 'CardCode',
        fetchPaged:    (opts)  => dbService.getOutstandingPaged(opts),
        fetchByCodes:  (codes) => dbService.getOutstandingDataByCodes(codes),
        mapPayload:    (rows)  => mapper.mapToOutstandingPayload(rows),
        sfPush:        (pl)    => sfService.upsertOutstanding(pl),
        // failedDetails: [{batch, codes:['CardCode:InvoiceNo'], error}]
        extractResults(sfResult, requestedKeys) {
            const failedCardCodes = new Set();
            for (const f of (sfResult.failedDetails || [])) {
                for (const code of (f.codes || [])) failedCardCodes.add(code.split(':')[0]);
            }
            return {
                success: requestedKeys.filter(k => !failedCardCodes.has(k)),
                failed:  [...failedCardCodes].map(k => ({ key: k, error: 'Batch failed' })),
            };
        },
    },

    invoice: {
        masterType:    'invoice',
        recordKeyField: 'DocEntry',
        fetchPaged:    (opts)  => dbService.getInvoicesPaged(opts),
        fetchByCodes:  (codes) => dbService.getInvoiceData({ docEntries: codes }),
        mapPayload:    (rows)  => mapper.mapToInvoicePayload(rows),
        sfPush:        (pl)    => sfService.upsertInvoices(pl),
        // Exact JSON body POSTed to InvoiceAPI for one invoice
        previewBody:   (pl)    => ({ InvoiceHeader: pl.map(p => p.invoice) }),
        // failedDetails: [{batch, codes:[DocEntry], docNums, error}]
        extractResults(sfResult, requestedKeys) {
            const failedMap = {};
            for (const f of (sfResult.failedDetails || [])) {
                const err = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
                for (const code of (f.codes || [])) failedMap[String(code)] = err;
            }
            return {
                success: requestedKeys.map(String).filter(k => !failedMap[k]),
                failed:  Object.entries(failedMap).map(([k, e]) => ({ key: k, error: e })),
            };
        },
    },

    salereturn: {
        masterType:    'salereturn',
        recordKeyField: 'DocEntry',
        fetchPaged:    (opts)  => dbService.getSaleReturnsPaged(opts),
        fetchByCodes:  (codes) => dbService.getSaleReturnData({ docEntries: codes }),
        mapPayload:    (rows)  => mapper.mapToSaleReturnPayload(rows),
        sfPush:        (pl)    => sfService.upsertSaleReturns(pl),
        // Exact JSON body POSTed to SaleReturnAPI for one return
        previewBody:   (pl)    => mapper.buildSaleReturnBody(pl),
        // Same failedDetails shape as invoices
        extractResults(sfResult, requestedKeys) {
            return MASTERS.invoice.extractResults(sfResult, requestedKeys);
        },
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/master/:masterType/list
// Query params: page, limit, search, pushStatus
// ─────────────────────────────────────────────────────────────────────────────
exports.getMasterList = async (req, res) => {
    const cfg = MASTERS[req.params.masterType];
    if (!cfg) return res.status(404).json({ success: false, error: 'Unknown master type' });

    try {
        await recordPushSvc.ensureTable();

        const page         = Math.max(1, parseInt(req.query.page,  10) || 1);
        const limit        = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
        const search       = req.query.search       || null;
        const pushStatus   = req.query.pushStatus   || null;
        const productGroup = req.query.productGroup || null;
        const fromDate     = req.query.fromDate     || null;
        const toDate       = req.query.toDate       || null;

        const result = await cfg.fetchPaged({ page, limit, search, pushStatus, productGroup, fromDate, toDate });
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        console.error(`[masterController] getMasterList (${req.params.masterType}) error:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/master/:masterType/push
// Body: { recordKeys: ["K001", "K002", ...] }
// Synchronous — waits for SF response, returns full result.
// ─────────────────────────────────────────────────────────────────────────────
exports.pushMasterRecords = async (req, res) => {
    const cfg = MASTERS[req.params.masterType];
    if (!cfg) return res.status(404).json({ success: false, error: 'Unknown master type' });

    const { recordKeys } = req.body;
    if (!Array.isArray(recordKeys) || recordKeys.length === 0) {
        return res.status(400).json({ success: false, error: 'recordKeys must be a non-empty array' });
    }

    await recordPushSvc.setManyPushing(cfg.masterType, recordKeys);

    try {
        const rows = await cfg.fetchByCodes(recordKeys);
        if (!rows.length) {
            await recordPushSvc.setBulkResults(cfg.masterType,
                recordKeys.map(k => ({ recordKey: k, success: false, errorMessage: 'Record not found in DB' }))
            );
            return res.status(404).json({ success: false, error: 'No data found for the given keys', requestedKeys: recordKeys });
        }

        const payload = cfg.mapPayload(rows);
        if (!payload.length) {
            await recordPushSvc.setBulkResults(cfg.masterType,
                recordKeys.map(k => ({ recordKey: k, success: false, errorMessage: 'Mapper produced no output' }))
            );
            return res.status(422).json({ success: false, error: 'Mapper produced no payload' });
        }

        const sfResult = await cfg.sfPush(payload);
        const { success: successKeys, failed } = cfg.extractResults(sfResult, recordKeys);

        await recordPushSvc.setBulkResults(cfg.masterType, [
            ...successKeys.map(k  => ({ recordKey: k,     success: true,  errorMessage: null })),
            ...failed.map(f       => ({ recordKey: f.key, success: false, errorMessage: f.error })),
        ]);

        return res.status(200).json({
            success:        failed.length === 0,
            totalRequested: recordKeys.length,
            successCount:   successKeys.length,
            failedCount:    failed.length,
            failedRecords:  failed,
        });

    } catch (err) {
        await recordPushSvc.setBulkResults(cfg.masterType,
            recordKeys.map(k => ({ recordKey: k, success: false, errorMessage: err.message }))
        );
        console.error(`[masterController] pushMasterRecords (${req.params.masterType}) error:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/master/:masterType/push-all
// Body: { search?, pushStatus? }
// Async background — responds immediately, pushes all pages in background.
// ─────────────────────────────────────────────────────────────────────────────
exports.pushAllMasterRecords = async (req, res) => {
    const cfg = MASTERS[req.params.masterType];
    if (!cfg) return res.status(404).json({ success: false, error: 'Unknown master type' });

    const { search, pushStatus, productGroup, fromDate, toDate } = req.body;

    res.status(200).json({
        success: true,
        message: 'Push-all started in background. Refresh the grid to see progress.',
    });

    (async () => {
        const PAGE = 100;

        // Collect every matching key up front — pushing while paging through a
        // status-filtered list shifts later pages and skips records.
        const allKeys = [];
        try {
            let page  = 1;
            let total = Infinity;
            while ((page - 1) * PAGE < total) {
                const result = await cfg.fetchPaged({ page, limit: PAGE, search, pushStatus, productGroup, fromDate, toDate });
                total = result.total;
                if (!result.data.length) break;
                allKeys.push(...result.data.map(r => r[cfg.recordKeyField]));
                page++;
            }
        } catch (err) {
            console.error(`[pushAll:${cfg.masterType}] key collection error:`, err.message);
        }

        for (let page = 1; (page - 1) * PAGE < allKeys.length; page++) {
            try {
                const keys = allKeys.slice((page - 1) * PAGE, page * PAGE);
                await recordPushSvc.setManyPushing(cfg.masterType, keys);

                const rows    = await cfg.fetchByCodes(keys);
                const payload = cfg.mapPayload(rows);

                if (payload.length > 0) {
                    const sfResult = await cfg.sfPush(payload);
                    const { success: successKeys, failed } = cfg.extractResults(sfResult, keys);
                    await recordPushSvc.setBulkResults(cfg.masterType, [
                        ...successKeys.map(k => ({ recordKey: k,     success: true,  errorMessage: null })),
                        ...failed.map(f      => ({ recordKey: f.key, success: false, errorMessage: f.error })),
                    ]);
                }
            } catch (err) {
                console.error(`[pushAll:${cfg.masterType}] page ${page} error:`, err.message);
            }
        }
        console.log(`[pushAll:${cfg.masterType}] background job complete`);
    })();
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/master/:masterType/preview/:recordKey
// Returns the exact JSON body that would be POSTed to Salesforce (no push).
// Only for masters that define previewBody.
// ─────────────────────────────────────────────────────────────────────────────
exports.previewMasterPayload = async (req, res) => {
    const cfg = MASTERS[req.params.masterType];
    if (!cfg || !cfg.previewBody) return res.status(404).json({ success: false, error: 'Preview not available for this master type' });

    try {
        const rows = await cfg.fetchByCodes([req.params.recordKey]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Record not found in DB' });
        return res.status(200).json({ success: true, payload: cfg.previewBody(cfg.mapPayload(rows)) });
    } catch (err) {
        console.error(`[masterController] previewMasterPayload (${req.params.masterType}) error:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
};
