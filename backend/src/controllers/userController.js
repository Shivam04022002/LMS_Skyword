'use strict';

const userService = require('../services/userService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/users */
const listUsers = asyncHandler(async (req, res) => {
  const data = await userService.listUsers(req.query);
  return sendSuccess(res, { message: 'Users fetched successfully', data });
});

/** GET /api/admin/users/:id */
const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  return sendSuccess(res, { message: 'User fetched successfully', data: { user } });
});

/** POST /api/admin/users */
const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'User created successfully', data: { user } });
});

/** PUT /api/admin/users/:id */
const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'User updated successfully', data: { user } });
});

/** PATCH /api/admin/users/:id/status */
const changeStatus = asyncHandler(async (req, res) => {
  const user = await userService.changeStatus(req.params.id, req.body.status, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'User status updated successfully', data: { user } });
});

/** PATCH /api/admin/users/:id/role */
const changeRole = asyncHandler(async (req, res) => {
  const user = await userService.changeRole(req.params.id, req.body.role, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'User role updated successfully', data: { user } });
});

/** POST /api/admin/users/:id/reset-password */
const resetPassword = asyncHandler(async (req, res) => {
  await userService.resetPassword(req.params.id, req.body.newPassword, req.user, auditService.contextFrom(req));
  // Nothing about the credential is echoed back.
  return sendSuccess(res, { message: 'Password reset successfully', data: {} });
});

module.exports = { listUsers, getUser, createUser, updateUser, changeStatus, changeRole, resetPassword };
