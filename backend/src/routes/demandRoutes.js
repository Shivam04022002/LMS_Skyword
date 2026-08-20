'use strict';

const express = require('express');
const demandController = require('../controllers/demandController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const { demandRules, demandSummaryRules } = require('../validators/demandValidator');

const router = express.Router();

router.use(authMiddleware);

/**
 * Demand is strictly read-only: it is derived from instalments and never writes
 * to a collection, allocation or instalment row. There are no mutating verbs on
 * this router by design.
 */
router.get('/', requirePermission(PERMISSIONS.DEMAND_VIEW), validate(demandRules), demandController.getDemand);

router.get('/routes', requirePermission(PERMISSIONS.DEMAND_VIEW), validate(demandSummaryRules), demandController.getRouteSummary);

module.exports = router;
