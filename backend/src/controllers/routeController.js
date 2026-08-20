'use strict';

const routeService = require('../services/routeService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/routes */
const listRoutes = asyncHandler(async (req, res) => {
  const data = await routeService.listRoutes(req.query, req.user);
  return sendSuccess(res, { message: 'Routes fetched successfully', data });
});

/** GET /api/admin/routes/:id */
const getRoute = asyncHandler(async (req, res) => {
  const route = await routeService.getRouteById(req.params.id, req.user);
  return sendSuccess(res, { message: 'Route fetched successfully', data: { route } });
});

/** POST /api/admin/routes */
const createRoute = asyncHandler(async (req, res) => {
  const route = await routeService.createRoute(req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'Route created successfully', data: { route } });
});

/** PUT /api/admin/routes/:id */
const updateRoute = asyncHandler(async (req, res) => {
  const route = await routeService.updateRoute(req.params.id, req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'Route updated successfully', data: { route } });
});

/** PATCH /api/admin/routes/:id/status */
const changeStatus = asyncHandler(async (req, res) => {
  const route = await routeService.changeStatus(req.params.id, req.body.status, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'Route status updated successfully', data: { route } });
});

/** POST /api/admin/routes/:id/collectors */
const assignCollector = asyncHandler(async (req, res) => {
  const assignment = await routeService.assignCollector(req.params.id, req.body.userId, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'Collector assigned successfully', data: { assignment } });
});

/** PATCH /api/admin/routes/:id/collectors/:assignmentId/status */
const changeCollectorAssignment = asyncHandler(async (req, res) => {
  const assignment = await routeService.changeCollectorAssignmentStatus(
    req.params.id,
    req.params.assignmentId,
    req.body.status,
    req.user,
    auditService.contextFrom(req)
  );
  return sendSuccess(res, { message: 'Collector assignment updated successfully', data: { assignment } });
});

/** POST /api/admin/routes/:id/loans */
const assignLoan = asyncHandler(async (req, res) => {
  const assignment = await routeService.assignLoan(req.params.id, req.body.loanId, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'Loan assigned to route successfully', data: { assignment } });
});

/** PATCH /api/admin/routes/:id/loans/:assignmentId/status */
const changeLoanAssignment = asyncHandler(async (req, res) => {
  const assignment = await routeService.changeLoanAssignmentStatus(
    req.params.id,
    req.params.assignmentId,
    req.body.status,
    req.user,
    auditService.contextFrom(req)
  );
  return sendSuccess(res, { message: 'Loan assignment updated successfully', data: { assignment } });
});

/** GET /api/admin/routes/:id/assignments — full history, active and past. */
const getAssignments = asyncHandler(async (req, res) => {
  const data = await routeService.getRouteAssignments(
    req.params.id,
    { includeRemoved: req.query.includeRemoved !== 'false' },
    req.user
  );
  return sendSuccess(res, { message: 'Route assignments fetched successfully', data });
});

module.exports = {
  listRoutes,
  getRoute,
  createRoute,
  updateRoute,
  changeStatus,
  assignCollector,
  changeCollectorAssignment,
  assignLoan,
  changeLoanAssignment,
  getAssignments
};
