'use strict';

const { query } = require('express-validator');
const { PERIOD_VALUES } = require('../config/dashboard');

/** Same date rule the reports use — malformed and impossible dates both 422. */
const dateRule = (field) =>
  query(field)
    .optional()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage(`${field} must be in YYYY-MM-DD format`)
    .bail()
    .isISO8601({ strict: true })
    .withMessage(`${field} must be a real calendar date`);

const dashboardRules = [
  query('period').optional().isIn(PERIOD_VALUES).withMessage(`period must be one of: ${PERIOD_VALUES.join(', ')}`),
  dateRule('date'),
  dateRule('dateFrom'),
  dateRule('dateTo'),
  query('routeId').optional().isInt({ min: 1 }).withMessage('routeId must be a positive integer'),
  query('collectorId').optional().isInt({ min: 1 }).withMessage('collectorId must be a positive integer')
];

module.exports = { dashboardRules };
