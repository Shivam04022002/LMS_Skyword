'use strict';

const { Role, Permission, User } = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const { ROLES } = require('../config/roles');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

const PERMISSION_INCLUDE = { association: 'Permissions', through: { attributes: [] } };

async function listRoles() {
  const roles = await Role.findAll({
    include: [PERMISSION_INCLUDE],
    order: [['id', 'ASC']]
  });

  // User counts let the UI warn before a role is emptied of permissions.
  const counts = await User.count({ group: ['roleId'] });
  const countByRoleId = counts.reduce((accumulator, row) => {
    accumulator[row.roleId] = Number(row.count);
    return accumulator;
  }, {});

  return roles.map((role) => ({ ...role.toPublicJSON(), userCount: countByRoleId[role.id] ?? 0 }));
}

async function getRoleById(roleId) {
  const role = await Role.findByPk(roleId, { include: [PERMISSION_INCLUDE] });
  if (!role) {
    throw ApiError.notFound('Role not found');
  }
  return role.toPublicJSON();
}

async function listPermissions() {
  const permissions = await Permission.findAll({ order: [['name', 'ASC']] });
  return permissions.map((permission) => permission.toPublicJSON());
}

/**
 * Replaces the permission set of a role.
 * SUPER_ADMIN is intentionally immutable — stripping it would make the
 * permission system unrecoverable through the UI.
 */
async function updateRolePermissions(roleId, permissionNames, context) {
  const role = await Role.findByPk(roleId, { include: [PERMISSION_INCLUDE] });
  if (!role) {
    throw ApiError.notFound('Role not found');
  }

  if (role.name === ROLES.SUPER_ADMIN) {
    throw ApiError.forbidden('The SUPER_ADMIN role always holds every permission and cannot be edited');
  }

  const requested = [...new Set(permissionNames)];
  const permissions = await Permission.findAll({ where: { name: requested } });

  if (permissions.length !== requested.length) {
    const found = permissions.map((permission) => permission.name);
    const unknown = requested.filter((name) => !found.includes(name));
    throw ApiError.badRequest('Unknown permission(s) requested', unknown.map((name) => ({ field: 'permissions', message: `Unknown permission "${name}"` })));
  }

  const previous = role.permissionNames();
  await role.setPermissions(permissions);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ROLE_PERMISSIONS_UPDATED,
    entity: AUDIT_ENTITIES.ROLE,
    entityId: role.id,
    details: {
      role: role.name,
      added: requested.filter((name) => !previous.includes(name)),
      removed: previous.filter((name) => !requested.includes(name))
    }
  });

  return getRoleById(role.id);
}

module.exports = { listRoles, getRoleById, listPermissions, updateRolePermissions };
