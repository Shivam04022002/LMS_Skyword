'use strict';

const { body, param, query } = require('express-validator');
const { PARTY_ROLE_VALUES, PARTY_STATUS_VALUES } = require('../config/loanParties');
const { CIF_ID_PATTERN } = require('../config/customers');

const loanIdRule = param('loanId').isInt({ min: 1 }).withMessage('A valid loan id is required');
const partyIdRule = param('partyId').isInt({ min: 1 }).withMessage('A valid party id is required');

/**
 * Fields the backend owns. `isPrimary` is derived from the role — accepting it
 * would let a request create a non-primary applicant or a primary guarantor.
 */
const backendControlledRules = [
  body('isPrimary').not().exists().withMessage('isPrimary is derived from the party role and cannot be set'),
  body('is_primary').not().exists().withMessage('is_primary is derived from the party role and cannot be set'),
  body('status').not().exists().withMessage('Use PATCH /:partyId/status to change a party status'),
  body('createdBy').not().exists().withMessage('createdBy is set by the system'),
  body('updatedBy').not().exists().withMessage('updatedBy is set by the system'),
  body('loanId').not().exists().withMessage('The loan is taken from the URL')
];

const listPartiesRules = [
  loanIdRule,
  query('includeRemoved').optional().isBoolean().withMessage('includeRemoved must be true or false')
];

const addPartyRules = [
  loanIdRule,
  body('partyRole')
    .notEmpty()
    .withMessage('Party role is required')
    .bail()
    .isIn(PARTY_ROLE_VALUES)
    .withMessage(`Party role must be one of: ${PARTY_ROLE_VALUES.join(', ')}`),
  body('customerId').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('customerId must be a positive integer'),
  body('cifId')
    .optional({ values: 'falsy' })
    .isString()
    .withMessage('cifId must be text')
    .bail()
    .trim()
    .toUpperCase()
    .matches(CIF_ID_PATTERN)
    .withMessage('cifId must look like C000001'),
  // The customer is identified one way or the other, never invented.
  body().custom((value) => {
    if (!value.customerId && !value.cifId) {
      throw new Error('Provide either customerId or cifId to identify the customer');
    }
    return true;
  }),
  ...backendControlledRules
];

const updatePartyRules = [
  loanIdRule,
  partyIdRule,
  body('partyRole')
    .notEmpty()
    .withMessage('Party role is required')
    .bail()
    .isIn(PARTY_ROLE_VALUES)
    .withMessage(`Party role must be one of: ${PARTY_ROLE_VALUES.join(', ')}`),
  body('customerId').not().exists().withMessage('The customer on a party cannot be changed — remove the party and add another'),
  body('cifId').not().exists().withMessage('The customer on a party cannot be changed — remove the party and add another'),
  ...backendControlledRules
];

const changePartyStatusRules = [
  loanIdRule,
  partyIdRule,
  body('status')
    .notEmpty()
    .withMessage('Status is required')
    .bail()
    .isIn(PARTY_STATUS_VALUES)
    .withMessage(`Status must be one of: ${PARTY_STATUS_VALUES.join(', ')}`)
];

const swapRules = [
  loanIdRule,
  body('coApplicantPartyId')
    .optional({ values: 'falsy' })
    .isInt({ min: 1 })
    .withMessage('coApplicantPartyId must be a positive integer')
];

module.exports = { listPartiesRules, addPartyRules, updatePartyRules, changePartyStatusRules, swapRules };
