const dbService = require('../services/dbService');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pricelist/rows
// Row-level (one row per ProductCode+SubBrandCode) price list listing.
// Query params: page, limit, search, productGroup, subBrand, activeOnly, sortBy, sortDir
// ─────────────────────────────────────────────────────────────────────────────
exports.getPriceListRows = async (req, res) => {
    try {
        const page         = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit         = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
        const search        = req.query.search       || null;
        const productGroup  = req.query.productGroup || null;
        const subBrand      = req.query.subBrand     || null;
        const activeOnly    = req.query.activeOnly === 'true' || req.query.activeOnly === '1';
        const sortBy        = req.query.sortBy  || null;
        const sortDir       = req.query.sortDir || null;

        const result = await dbService.getPriceListRowsPaged({
            page, limit, search, productGroup, subBrand, activeOnly, sortBy, sortDir,
        });
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        console.error('[priceListController] getPriceListRows error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pricelist/states
// Distinct SubBrandCode (state) values for the filter dropdown.
// ─────────────────────────────────────────────────────────────────────────────
exports.getPriceListStates = async (req, res) => {
    try {
        const states = await dbService.getPriceListStates();
        return res.status(200).json({ success: true, data: states });
    } catch (err) {
        console.error('[priceListController] getPriceListStates error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
};
