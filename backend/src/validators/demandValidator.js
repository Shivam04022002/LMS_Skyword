'use strict';

const { query } = require('express-validator');
const { DEMAND_BUCKET_VALUES } = require('../config/routes');

/**
 * The business date must be an explicit YYYY-MM-DD when supplied. It is never
 * silently coerced: an unparseable date is a 422, and an omitted date falls back
 * to the server's business date via utils/dates.today(), matching how DPD and
 * EMI status are derived elsewhere.
 */
const dateRule = query('date')
  .optional()
  .matches(/^\d{4}-\d{2}-\d{2}$/)
  .withMessage('date must be in YYYY-MM-DD format')
  .bail()
  .isISO8601({ strict: true })
  .withMessage('date must be a real calendar date');

const demandRules = [
  dateRule,
  query('routeId').optional().isInt({ min: 1 }).withMessage('routeId must be a positive integer'),
  query('collectorId').optional().isInt({ min: 1 }).withMessage('collectorId must be a positive integer'),
  query('loanId').optional().isInt({ min: 1 }).withMessage('loanId must be a positive integer'),
  query('customerId').optional().isInt({ min: 1 }).withMessage('customerId must be a positive integer'),
  query('bucket').optional().isIn(DEMAND_BUCKET_VALUES).withMessage(`bucket must be one of: ${DEMAND_BUCKET_VALUES.join(', ')}`),
  query('includeUpcoming').optional().isBoolean().withMessage('includeUpcoming must be true or false'),
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('limit must be between 1 and 500')
];

const demandSummaryRules = [dateRule, query('routeId').optional().isInt({ min: 1 }).withMessage('routeId must be a positive integer')];

module.exports = { demandRules, demandSummaryRules };
