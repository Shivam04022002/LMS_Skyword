'use strict';

const express = require('express');
const dashboardController = require('../controllers/dashboardController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const { dashboardRules } = require('../validators/dashboardValidator');

const router = express.Router();

router.use(authMiddleware);

/**
 * A single read-only endpoint. Data is scoped server-side by the same resolver
 * the reports use, so a collector receives only their own routes no matter what
 * filters they send.
 */
router.get('/', requirePermission(PERMISSIONS.DASHBOARD_VIEW), validate(dashboardRules), dashboardController.getDashboard);

module.exports = router;
