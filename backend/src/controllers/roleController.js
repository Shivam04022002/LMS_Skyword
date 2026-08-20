'use strict';

const roleService = require('../services/roleService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/roles */
const listRoles = asyncHandler(async (req, res) => {
  const roles = await roleService.listRoles();
  return sendSuccess(res, { message: 'Roles fetched successfully', data: { roles } });
});

/** GET /api/admin/roles/:id */
const getRole = asyncHandler(async (req, res) => {
  const role = await roleService.getRoleById(req.params.id);
  return sendSuccess(res, { message: 'Role fetched successfully', data: { role } });
});

/** PUT /api/admin/roles/:id/permissions */
const updateRolePermissions = asyncHandler(async (req, res) => {
  const role = await roleService.updateRolePermissions(req.params.id, req.body.permissions, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'Role permissions updated successfully', data: { role } });
});

/** GET /api/admin/permissions */
const listPermissions = asyncHandler(async (req, res) => {
  const permissions = await roleService.listPermissions();
  return sendSuccess(res, { message: 'Permissions fetched successfully', data: { permissions } });
});

module.exports = { listRoles, getRole, updateRolePermissions, listPermissions };
