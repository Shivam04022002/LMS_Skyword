'use strict';

const express = require('express');
const routeController = require('../controllers/routeController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const {
  createRouteRules,
  updateRouteRules,
  changeStatusRules,
  assignCollectorRules,
  assignLoanRules,
  assignmentStatusRules,
  routeIdRules,
  listRoutesRules,
  assignmentsRules
} = require('../validators/routeValidator');

const router = express.Router();

router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.ROUTES_VIEW), validate(listRoutesRules), routeController.listRoutes);

router.post('/', requirePermission(PERMISSIONS.ROUTES_CREATE), validate(createRouteRules), routeController.createRoute);

router.get('/:id', requirePermission(PERMISSIONS.ROUTES_VIEW), validate(routeIdRules), routeController.getRoute);

router.put('/:id', requirePermission(PERMISSIONS.ROUTES_UPDATE), validate(updateRouteRules), routeController.updateRoute);

router.patch('/:id/status', requirePermission(PERMISSIONS.ROUTES_UPDATE), validate(changeStatusRules), routeController.changeStatus);

// Full assignment history for a route — collectors and loans, active and past.
router.get('/:id/assignments', requirePermission(PERMISSIONS.ROUTES_VIEW), validate(assignmentsRules), routeController.getAssignments);

router.post('/:id/collectors', requirePermission(PERMISSIONS.ROUTES_ASSIGN), validate(assignCollectorRules), routeController.assignCollector);

router.patch(
  '/:id/collectors/:assignmentId/status',
  requirePermission(PERMISSIONS.ROUTES_ASSIGN),
  validate(assignmentStatusRules),
  routeController.changeCollectorAssignment
);

router.post('/:id/loans', requirePermission(PERMISSIONS.ROUTES_ASSIGN), validate(assignLoanRules), routeController.assignLoan);

router.patch(
  '/:id/loans/:assignmentId/status',
  requirePermission(PERMISSIONS.ROUTES_ASSIGN),
  validate(assignmentStatusRules),
  routeController.changeLoanAssignment
);

/**
 * There is deliberately no DELETE. Routes are deactivated and assignments are
 * soft-removed, so historical relationships stay readable.
 */

module.exports = router;
