'use strict';

const { Op } = require('sequelize');
const { User, Role } = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const { ROLES, USER_STATUS } = require('../config/roles');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

const SORTABLE_FIELDS = ['name', 'email', 'status', 'createdAt', 'updatedAt'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ROLE_INCLUDE = { association: 'Role', include: [{ association: 'Permissions', through: { attributes: [] } }] };

/** Loads a user with role + permissions, or throws 404. */
async function findUserOrFail(userId) {
  const user = await User.scope('withRole').findByPk(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return user;
}

async function findRoleByNameOrFail(roleName) {
  const role = await Role.findOne({ where: { name: roleName } });
  if (!role) {
    throw ApiError.badRequest(`Unknown role "${roleName}"`);
  }
  return role;
}

/** A SUPER_ADMIN account may only be touched by another SUPER_ADMIN. */
function assertCanManageTarget(actor, target) {
  if (target.role === ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPER_ADMIN) {
    throw ApiError.forbidden('Only a SUPER_ADMIN can manage a SUPER_ADMIN account');
  }
}

/** Blocks privilege escalation: granting SUPER_ADMIN requires being one. */
function assertCanAssignRole(actor, roleName) {
  if (roleName === ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPER_ADMIN) {
    throw ApiError.forbidden('Only a SUPER_ADMIN can grant the SUPER_ADMIN role');
  }
}

function assertNotSelf(actor, targetId, message) {
  if (Number(actor.id) === Number(targetId)) {
    throw ApiError.forbidden(message);
  }
}

/** Number of SUPER_ADMIN accounts that can currently log in. */
async function countActiveSuperAdmins() {
  const superAdminRole = await Role.findOne({ where: { name: ROLES.SUPER_ADMIN } });
  if (!superAdminRole) return 0;
  return User.count({ where: { roleId: superAdminRole.id, status: USER_STATUS.ACTIVE } });
}

/**
 * Refuses an operation that would leave the system with no way back in.
 * Only relevant when the target is currently an active SUPER_ADMIN.
 */
async function assertNotLastActiveSuperAdmin(target, action) {
  if (target.role !== ROLES.SUPER_ADMIN || target.status !== USER_STATUS.ACTIVE) return;

  const remaining = await countActiveSuperAdmins();
  if (remaining <= 1) {
    throw ApiError.conflict(`Cannot ${action}: this is the last active SUPER_ADMIN account`);
  }
}

/** GET /api/admin/users — paginated, searchable, filterable. */
async function listUsers({ page = 1, limit = DEFAULT_LIMIT, search, role, status, sortBy = 'createdAt', sortOrder = 'DESC' } = {}) {
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));

  const where = {};

  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    where[Op.or] = [{ name: { [Op.like]: term } }, { email: { [Op.like]: term } }];
  }

  if (status) {
    where.status = status;
  }

  const roleInclude = { ...ROLE_INCLUDE };
  if (role) {
    roleInclude.where = { name: role };
    roleInclude.required = true;
  }

  const field = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'createdAt';
  const direction = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const { rows, count } = await User.findAndCountAll({
    where,
    include: [roleInclude],
    order: [[field, direction]],
    limit: pageSize,
    offset: (currentPage - 1) * pageSize,
    // Required so the join against role_permissions does not inflate the count.
    distinct: true
  });

  return {
    users: rows.map((user) => user.toPublicJSON()),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: count,
      totalPages: Math.ceil(count / pageSize) || 0
    }
  };
}

async function getUserById(userId) {
  const user = await findUserOrFail(userId);
  return user.toAuthJSON();
}

/** POST /api/admin/users */
async function createUser({ name, email, password, role, status = USER_STATUS.ACTIVE }, actor, context) {
  assertCanAssignRole(actor, role);

  const targetRole = await findRoleByNameOrFail(role);
  const normalizedEmail = String(email).trim().toLowerCase();

  const existing = await User.findOne({ where: { email: normalizedEmail } });
  if (existing) {
    throw ApiError.conflict('This email address is already registered');
  }

  // The beforeSave hook hashes the password; it is never stored in plain text.
  const created = await User.create({
    name,
    email: normalizedEmail,
    password,
    roleId: targetRole.id,
    status
  });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.USER_CREATED,
    entity: AUDIT_ENTITIES.USER,
    entityId: created.id,
    details: { name: created.name, email: created.email, role: targetRole.name, status: created.status }
  });

  return getUserById(created.id);
}

/**
 * PUT /api/admin/users/:id
 * Role and password are deliberately out of scope here — each has its own
 * endpoint and its own permission.
 */
async function updateUser(userId, { name, email, status }, actor, context) {
  const target = await findUserOrFail(userId);
  assertCanManageTarget(actor, target);

  const changes = {};

  if (name !== undefined && name !== target.name) changes.name = name;

  if (email !== undefined) {
    const normalizedEmail = String(email).trim().toLowerCase();
    if (normalizedEmail !== target.email) {
      const clash = await User.findOne({ where: { email: normalizedEmail, id: { [Op.ne]: target.id } } });
      if (clash) {
        throw ApiError.conflict('This email address is already registered');
      }
      changes.email = normalizedEmail;
    }
  }

  if (status !== undefined && status !== target.status) {
    assertNotSelf(actor, target.id, 'You cannot change your own status');
    if (status === USER_STATUS.INACTIVE) {
      await assertNotLastActiveSuperAdmin(target, 'deactivate this account');
    }
    changes.status = status;
  }

  if (Object.keys(changes).length === 0) {
    return target.toAuthJSON();
  }

  await target.update(changes);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.USER_UPDATED,
    entity: AUDIT_ENTITIES.USER,
    entityId: target.id,
    details: { changed: Object.keys(changes), ...changes }
  });

  return getUserById(target.id);
}

/** PATCH /api/admin/users/:id/status */
async function changeStatus(userId, status, actor, context) {
  const target = await findUserOrFail(userId);

  assertCanManageTarget(actor, target);
  assertNotSelf(actor, target.id, 'You cannot change your own status');

  if (target.status === status) {
    return target.toAuthJSON();
  }

  if (status === USER_STATUS.INACTIVE) {
    await assertNotLastActiveSuperAdmin(target, 'deactivate this account');
  }

  await target.update({ status });

  await auditService.record({
    ...context,
    action: status === USER_STATUS.ACTIVE ? AUDIT_ACTIONS.USER_ACTIVATED : AUDIT_ACTIONS.USER_DEACTIVATED,
    entity: AUDIT_ENTITIES.USER,
    entityId: target.id,
    details: { status }
  });

  return getUserById(target.id);
}

/** PATCH /api/admin/users/:id/role */
async function changeRole(userId, roleName, actor, context) {
  const target = await findUserOrFail(userId);

  assertCanManageTarget(actor, target);
  assertNotSelf(actor, target.id, 'You cannot change your own role');
  assertCanAssignRole(actor, roleName);

  if (target.role === roleName) {
    return target.toAuthJSON();
  }

  // Demoting the last SUPER_ADMIN would lock everyone out of role management.
  await assertNotLastActiveSuperAdmin(target, 'change the role of this account');

  const previousRole = target.role;
  const nextRole = await findRoleByNameOrFail(roleName);

  await target.update({ roleId: nextRole.id });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ROLE_CHANGED,
    entity: AUDIT_ENTITIES.USER,
    entityId: target.id,
    details: { from: previousRole, to: nextRole.name }
  });

  return getUserById(target.id);
}

/**
 * POST /api/admin/users/:id/reset-password
 * Administrative reset. The new password arrives in the request body, is hashed
 * by the model hook, and is never logged, echoed or audited.
 */
async function resetPassword(userId, newPassword, actor, context) {
  const target = await findUserOrFail(userId);
  assertCanManageTarget(actor, target);

  await target.update({ password: newPassword });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.PASSWORD_RESET,
    entity: AUDIT_ENTITIES.USER,
    entityId: target.id,
    details: { email: target.email }
  });

  return { id: target.id };
}

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  changeStatus,
  changeRole,
  resetPassword,
  countActiveSuperAdmins
};
