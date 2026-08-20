'use strict';

const express = require('express');
const emiController = require('../controllers/emiController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const {
  listScheduleRules,
  emiIdRules,
  generateRules,
  recalculateRules,
  bounceChargeRules
} = require('../validators/emiValidator');

// mergeParams so :loanId from the parent mount is visible here.
const router = express.Router({ mergeParams: true });

router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.EMIS_VIEW), validate(listScheduleRules), emiController.listSchedule);

// Declared before /:emiId so these words are never read as an EMI id.
router.post('/generate', requirePermission(PERMISSIONS.EMIS_GENERATE), validate(generateRules), emiController.generateSchedule);

router.post('/recalculate', requirePermission(PERMISSIONS.EMIS_UPDATE), validate(recalculateRules), emiController.recalculate);

router.get('/:emiId', requirePermission(PERMISSIONS.EMIS_VIEW), validate(emiIdRules), emiController.getEmi);

/**
 * The one exception to the rule below: a bounce charge is not part of the
 * schedule's arithmetic, so recording one amends nothing financial. Its own
 * permission and its own audit action keep it distinguishable in the trail.
 */
router.patch(
  '/:emiId/bounce-charge',
  requirePermission(PERMISSIONS.EMIS_BOUNCE_CHARGE),
  validate(bounceChargeRules),
  emiController.updateBounceCharge
);

/**
 * There is otherwise deliberately no PUT/PATCH/DELETE on an instalment: a
 * generated schedule is financial history. Corrections require a controlled
 * amendment workflow, and collections are recorded by the collection module.
 */

module.exports = router;
