'use strict';

const express = require('express');
const loanPartyController = require('../controllers/loanPartyController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const {
  listPartiesRules,
  addPartyRules,
  updatePartyRules,
  changePartyStatusRules,
  swapRules
} = require('../validators/loanPartyValidator');

// mergeParams so :loanId from the parent mount is visible here.
const router = express.Router({ mergeParams: true });

router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.LOAN_PARTIES_VIEW), validate(listPartiesRules), loanPartyController.listParties);

router.post('/', requirePermission(PERMISSIONS.LOAN_PARTIES_CREATE), validate(addPartyRules), loanPartyController.addParty);

// Declared before /:partyId so "swap" is never read as a party id.
router.post('/swap', requirePermission(PERMISSIONS.LOAN_PARTIES_SWAP), validate(swapRules), loanPartyController.swapApplicant);

router.put('/:partyId', requirePermission(PERMISSIONS.LOAN_PARTIES_UPDATE), validate(updatePartyRules), loanPartyController.updateParty);

/**
 * Soft removal only. There is deliberately no DELETE route: a loan's
 * participant history must remain readable.
 */
router.patch(
  '/:partyId/status',
  requirePermission(PERMISSIONS.LOAN_PARTIES_REMOVE),
  validate(changePartyStatusRules),
  loanPartyController.changePartyStatus
);

module.exports = router;
