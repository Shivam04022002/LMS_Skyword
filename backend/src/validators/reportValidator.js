'use strict';

const { param, query } = require('express-validator');
const { EXPORT_FORMAT_VALUES, MAX_LIMIT } = require('../config/reports');
const { LOAN_STATUS_VALUES, LOAN_TYPE_VALUES } = require('../config/loans');
const { COLLECTION_STATUS_VALUES, LEDGER_TYPE_VALUES } = require('../config/collections');
const { EMI_STATUS_VALUES } = require('../config/emis');

/**
 * Date rule shared by every report.
 *
 * Rejects malformed and impossible dates alike — `2026-02-30` and `18-08-2026`
 * both fail — using the same 422 envelope as the rest of the API.
 */
const dateRule = (field) =>
  query(field)
    .optional()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage(`${field} must be in YYYY-MM-DD format`)
    .bail()
    .isISO8601({ strict: true })
    .withMessage(`${field} must be a real calendar date`);

const pagingRules = [
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: MAX_LIMIT }).withMessage(`limit must be between 1 and ${MAX_LIMIT}`)
];

const scopeRules = [
  query('routeId').optional().isInt({ min: 1 }).withMessage('routeId must be a positive integer'),
  query('collectorId').optional().isInt({ min: 1 }).withMessage('collectorId must be a positive integer')
];

const formatRule = query('format')
  .optional()
  .isIn(EXPORT_FORMAT_VALUES)
  .withMessage(`format must be one of: ${EXPORT_FORMAT_VALUES.join(', ')}`);

const loanReportRules = [
  ...pagingRules,
  ...scopeRules,
  formatRule,
  dateRule('dateFrom'),
  dateRule('dateTo'),
  query('status').optional().isIn(LOAN_STATUS_VALUES).withMessage(`status must be one of: ${LOAN_STATUS_VALUES.join(', ')}`),
  query('loanType').optional().isIn(LOAN_TYPE_VALUES).withMessage(`loanType must be one of: ${LOAN_TYPE_VALUES.join(', ')}`),
  query('search').optional().isString().trim().isLength({ max: 120 }).withMessage('search is too long')
];

const collectionReportRules = [
  ...pagingRules,
  ...scopeRules,
  formatRule,
  dateRule('dateFrom'),
  dateRule('dateTo'),
  query('status').optional().isIn(COLLECTION_STATUS_VALUES).withMessage(`status must be one of: ${COLLECTION_STATUS_VALUES.join(', ')}`),
  query('ledgerType').optional().isIn(LEDGER_TYPE_VALUES).withMessage(`ledgerType must be one of: ${LEDGER_TYPE_VALUES.join(', ')}`),
  query('search').optional().isString().trim().isLength({ max: 120 }).withMessage('search is too long')
];

const emiReportRules = [
  ...pagingRules,
  ...scopeRules,
  formatRule,
  dateRule('date'),
  dateRule('dateFrom'),
  dateRule('dateTo'),
  query('status').optional().isIn(EMI_STATUS_VALUES).withMessage(`status must be one of: ${EMI_STATUS_VALUES.join(', ')}`),
  query('loanId').optional().isInt({ min: 1 }).withMessage('loanId must be a positive integer'),
  query('minDpd').optional().isInt({ min: 0, max: 100000 }).withMessage('minDpd must be a non-negative integer')
];

const demandCollectionReportRules = [
  ...scopeRules,
  formatRule,
  dateRule('date'),
  dateRule('dateFrom'),
  dateRule('dateTo')
];

const receiptRules = [param('id').isInt({ min: 1 }).withMessage('A valid collection id is required')];

module.exports = {
  loanReportRules,
  collectionReportRules,
  emiReportRules,
  demandCollectionReportRules,
  receiptRules
};
