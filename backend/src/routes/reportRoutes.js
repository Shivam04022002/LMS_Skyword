'use strict';

const express = require('express');
const reportController = require('../controllers/reportController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const { EXPORT_FORMAT_VALUES } = require('../config/reports');
const {
  loanReportRules,
  collectionReportRules,
  emiReportRules,
  demandCollectionReportRules
} = require('../validators/reportValidator');

const router = express.Router();

router.use(authMiddleware);

/**
 * Downloading requires reports.export on top of reports.view.
 *
 * Viewing is gated first, so an unauthorised caller is refused before the query
 * string is even considered; the export check then runs after validation has
 * confirmed `format` is a value we recognise.
 */
const requireExportPermission = (req, res, next) => {
  // ANY download format, not one named format: a new export type must never be
  // able to slip past this gate by not being CSV.
  if (!EXPORT_FORMAT_VALUES.includes(req.query.format)) {
    return next();
  }
  return requirePermission(PERMISSIONS.REPORTS_EXPORT)(req, res, next);
};

const report = (rules, handler) => [
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  validate(rules),
  requireExportPermission,
  handler
];

router.get('/loans', ...report(loanReportRules, reportController.loanReport));
router.get('/collections', ...report(collectionReportRules, reportController.collectionReport));
router.get('/emis', ...report(emiReportRules, reportController.emiReport));
router.get('/demand-collections', ...report(demandCollectionReportRules, reportController.demandCollectionReport));

/**
 * Reports are strictly read-only — no mutating verb is mounted here, and the
 * services perform no writes beyond the export audit entry.
 */

module.exports = router;
