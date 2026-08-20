'use strict';

const { body, param, query } = require('express-validator');
const { EMI_STATUS_VALUES, MAX_BOUNCE_CHARGE } = require('../config/emis');

const loanIdRule = param('loanId').isInt({ min: 1 }).withMessage('A valid loan id is required');
const emiIdRule = param('emiId').isInt({ min: 1 }).withMessage('A valid EMI id is required');

/**
 * Everything about an instalment is derived or owned by another phase. Rejecting
 * these outright keeps DPD system-calculated and leaves collection fields to
 * Phase 7, instead of silently ignoring whatever a client sends.
 */
const backendControlledRules = [
  body('dpd').not().exists().withMessage('DPD is calculated by the system and cannot be set'),
  body('status').not().exists().withMessage('EMI status is derived from the due date and collected amount'),
  body('amountCollected').not().exists().withMessage('Collections are recorded through the collection module'),
  body('paymentDate').not().exists().withMessage('Payment dates are recorded through the collection module'),
  body('emiAmount').not().exists().withMessage('Instalment amounts are generated from the loan'),
  body('principal').not().exists().withMessage('Instalment amounts are generated from the loan'),
  body('interest').not().exists().withMessage('Instalment amounts are generated from the loan'),
  body('emiDate').not().exists().withMessage('Due dates are generated from the loan start date'),
  body('emiNumber').not().exists().withMessage('Instalment numbers are generated from the loan')
];

const listScheduleRules = [
  loanIdRule,
  query('status').optional().isIn(EMI_STATUS_VALUES).withMessage(`status must be one of: ${EMI_STATUS_VALUES.join(', ')}`),
  query('emiNumber').optional().isInt({ min: 1 }).withMessage('emiNumber must be a positive integer'),
  query('dateFrom').optional().isISO8601().withMessage('dateFrom must be a valid date'),
  query('dateTo').optional().isISO8601().withMessage('dateTo must be a valid date'),
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('limit must be between 1 and 500')
];

const emiIdRules = [loanIdRule, emiIdRule];

const generateRules = [loanIdRule, ...backendControlledRules];

const recalculateRules = [loanIdRule, ...backendControlledRules];

/**
 * The one editable field on an instalment.
 *
 * Zero is valid and means "no charge" — this is how a charge is cleared, so the
 * rule is >= 0 rather than the > 0 used for a collection amount. Everything the
 * system derives is still rejected outright, so this endpoint cannot be used as
 * a back door into instalment or collection state.
 */
const bounceChargeRules = [
  loanIdRule,
  emiIdRule,
  body('bounceCharge')
    .exists()
    .withMessage('A bounce charge is required')
    .bail()
    // Rejects "1e5", "Infinity", "-0", " 12 ", negatives and more than two decimals.
    .custom((value) => /^\d+(\.\d{1,2})?$/.test(String(value)))
    .withMessage('Bounce charge must be a plain number of 0 or more, with at most 2 decimal places')
    .bail()
    .custom((value) => Number(value) <= Number(MAX_BOUNCE_CHARGE))
    .withMessage(`Bounce charge cannot exceed ${MAX_BOUNCE_CHARGE}`),
  ...backendControlledRules
];

module.exports = { listScheduleRules, emiIdRules, generateRules, recalculateRules, bounceChargeRules };
