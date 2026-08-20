'use strict';

const { Op } = require('sequelize');
const { sequelize, Route, RouteSequence, RouteCollector, LoanRoute, Loan, User } = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const { today } = require('../utils/dates');
const { formatRouteCode, ROUTE_STATUS, ASSIGNMENT_STATUS } = require('../config/routes');
const { ROLES, USER_STATUS } = require('../config/roles');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SORTABLE_FIELDS = ['routeCode', 'name', 'status', 'createdAt', 'updatedAt'];

/** Fields a client may set. `routeCode`, status and the actor stamps are ours. */
const EDITABLE_FIELDS = ['name', 'description'];

const COLLECTOR_INCLUDE = {
  association: 'Collectors',
  include: [
    { association: 'Collector', attributes: ['id', 'name', 'email', 'status'] },
    { association: 'AssignedBy', attributes: ['id', 'name'] }
  ]
};

const DETAIL_INCLUDE = [
  COLLECTOR_INCLUDE,
  { association: 'CreatedBy', attributes: ['id', 'name'] },
  { association: 'UpdatedBy', attributes: ['id', 'name'] }
];

function pickEditableFields(payload) {
  return EDITABLE_FIELDS.reduce((accumulator, field) => {
    if (payload[field] !== undefined) accumulator[field] = payload[field];
    return accumulator;
  }, {});
}

/**
 * Allocates the next route code.
 *
 * The counter row is read with `SELECT ... FOR UPDATE` inside the creating
 * transaction — `MAX(route_code) + 1` would race. UNIQUE(route_code) is the
 * final backstop, and a rolled-back creation releases the number.
 */
async function generateRouteCode(year, transaction) {
  let sequence = await RouteSequence.findOne({ where: { year }, transaction, lock: transaction.LOCK.UPDATE });

  if (!sequence) {
    await RouteSequence.create({ year, currentNumber: 0 }, { transaction });
    sequence = await RouteSequence.findOne({ where: { year }, transaction, lock: transaction.LOCK.UPDATE });
  }

  const nextNumber = Number(sequence.currentNumber) + 1;
  await sequence.update({ currentNumber: nextNumber }, { transaction });

  return formatRouteCode(year, nextNumber);
}

async function findRouteOrFail(routeId, options = {}) {
  const route = await Route.findByPk(routeId, { include: DETAIL_INCLUDE, ...options });
  if (!route) {
    throw ApiError.notFound('Route not found');
  }
  return route;
}

/**
 * Route ids a given collector is currently assigned to.
 * Used to scope what a COLLECTOR may see — they get their own routes only.
 */
async function activeRouteIdsForCollector(userId, transaction) {
  const assignments = await RouteCollector.findAll({
    attributes: ['routeId'],
    where: { userId, status: ASSIGNMENT_STATUS.ACTIVE },
    transaction,
    raw: true
  });
  return assignments.map((assignment) => assignment.routeId);
}

/** True when the actor's visibility must be limited to their own routes. */
const isScopedActor = (actor) => actor?.role === ROLES.COLLECTOR;

/**
 * Only an ACTIVE user holding the COLLECTOR role may be assigned to a route.
 * Both halves matter: an inactive account cannot work a route, and a non-field
 * role must not be booked as one.
 */
async function assertAssignableCollector(userId, transaction) {
  const user = await User.scope('withRole').findByPk(userId, { transaction });

  if (!user) {
    throw ApiError.notFound('User not found');
  }
  if (user.role !== ROLES.COLLECTOR) {
    throw ApiError.badRequest(`Only users with the COLLECTOR role can be assigned to a route (this user is ${user.role})`);
  }
  if (user.status !== USER_STATUS.ACTIVE) {
    throw ApiError.conflict('This user is inactive and cannot be assigned to a route');
  }

  return user;
}

/** GET /api/admin/routes */
async function listRoutes({ page = 1, limit = DEFAULT_LIMIT, search, status, collectorId, sortBy = 'createdAt', sortOrder = 'DESC' } = {}, actor) {
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));

  const where = {};
  if (status) where.status = status;

  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    where[Op.or] = [{ routeCode: { [Op.like]: term } }, { name: { [Op.like]: term } }];
  }

  // A collector sees only the routes they are assigned to.
  let restrictTo = null;
  if (isScopedActor(actor)) {
    restrictTo = await activeRouteIdsForCollector(actor.id);
  } else if (collectorId) {
    restrictTo = await activeRouteIdsForCollector(Number(collectorId));
  }

  if (restrictTo) {
    where.id = restrictTo.length > 0 ? { [Op.in]: restrictTo } : { [Op.in]: [0] };
  }

  const field = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'createdAt';
  const direction = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const { rows, count } = await Route.findAndCountAll({
    where,
    order: [[field, direction]],
    limit: pageSize,
    offset: (currentPage - 1) * pageSize,
    distinct: true
  });

  const routeIds = rows.map((route) => route.id);
  const collectorCounts = await RouteCollector.count({
    where: { routeId: routeIds, status: ASSIGNMENT_STATUS.ACTIVE },
    group: ['routeId']
  });
  const loanCounts = await LoanRoute.count({
    where: { routeId: routeIds, status: ASSIGNMENT_STATUS.ACTIVE },
    group: ['routeId']
  });

  const byRoute = (counts) =>
    counts.reduce((accumulator, row) => {
      accumulator[row.routeId] = Number(row.count);
      return accumulator;
    }, {});

  const collectorsByRoute = byRoute(collectorCounts);
  const loansByRoute = byRoute(loanCounts);

  return {
    routes: rows.map((route) =>
      route.toListJSON({
        collectorCount: collectorsByRoute[route.id] ?? 0,
        loanCount: loansByRoute[route.id] ?? 0
      })
    ),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: count,
      totalPages: Math.ceil(count / pageSize) || 0
    }
  };
}

/** Throws unless a scoped actor is allowed to see this route. */
async function assertRouteVisible(routeId, actor) {
  if (!isScopedActor(actor)) return;
  const allowed = await activeRouteIdsForCollector(actor.id);
  if (!allowed.includes(Number(routeId))) {
    throw ApiError.forbidden('You are not assigned to this route');
  }
}

async function getRouteById(routeId, actor) {
  await assertRouteVisible(routeId, actor);
  const route = await findRouteOrFail(routeId);
  return route.toPublicJSON();
}

/** POST /api/admin/routes */
async function createRoute(payload, actor, context) {
  const attributes = pickEditableFields(payload);

  const routeId = await sequelize.transaction(async (transaction) => {
    const year = new Date().getFullYear();
    const routeCode = await generateRouteCode(year, transaction);

    const route = await Route.create(
      { ...attributes, routeCode, status: payload.status ?? ROUTE_STATUS.ACTIVE, createdBy: actor.id, updatedBy: actor.id },
      { transaction }
    );

    return route.id;
  });

  const route = await findRouteOrFail(routeId);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ROUTE_CREATED,
    entity: AUDIT_ENTITIES.ROUTE,
    entityId: route.id,
    details: { routeCode: route.routeCode, name: route.name, status: route.status }
  });

  return route.toPublicJSON();
}

/**
 * PUT /api/admin/routes/:id
 * `routeCode` is absent from EDITABLE_FIELDS, so it cannot be changed here
 * regardless of what the request contains.
 */
async function updateRoute(routeId, payload, actor, context) {
  const route = await findRouteOrFail(routeId);
  const attributes = pickEditableFields(payload);

  if (Object.keys(attributes).length === 0) {
    return route.toPublicJSON();
  }

  await route.update({ ...attributes, updatedBy: actor.id });

  const updated = await findRouteOrFail(routeId);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ROUTE_UPDATED,
    entity: AUDIT_ENTITIES.ROUTE,
    entityId: updated.id,
    details: { routeCode: updated.routeCode, changed: Object.keys(attributes) }
  });

  return updated.toPublicJSON();
}

/**
 * PATCH /api/admin/routes/:id/status
 * Routes are deactivated, never deleted; existing assignments stay readable.
 */
async function changeStatus(routeId, status, actor, context) {
  const route = await findRouteOrFail(routeId);

  if (route.status === status) {
    return route.toPublicJSON();
  }

  const previousStatus = route.status;
  await route.update({ status, updatedBy: actor.id });

  const updated = await findRouteOrFail(routeId);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ROUTE_STATUS_CHANGED,
    entity: AUDIT_ENTITIES.ROUTE,
    entityId: updated.id,
    details: { routeCode: updated.routeCode, from: previousStatus, to: status }
  });

  return updated.toPublicJSON();
}

/** POST /api/admin/routes/:id/collectors */
async function assignCollector(routeId, userId, actor, context, { asOf = today() } = {}) {
  const assignmentId = await sequelize.transaction(async (transaction) => {
    const route = await Route.findByPk(routeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!route) {
      throw ApiError.notFound('Route not found');
    }
    if (route.status !== ROUTE_STATUS.ACTIVE) {
      throw ApiError.conflict('Collectors cannot be assigned to an inactive route');
    }

    await assertAssignableCollector(userId, transaction);

    const existing = await RouteCollector.findOne({
      where: { routeId: route.id, userId, status: ASSIGNMENT_STATUS.ACTIVE },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (existing) {
      throw ApiError.conflict('This collector is already assigned to this route');
    }

    // A new row rather than reviving an old one, so each assignment period is
    // its own recoverable record.
    const assignment = await RouteCollector.create(
      { routeId: route.id, userId, status: ASSIGNMENT_STATUS.ACTIVE, assignedAt: asOf, assignedBy: actor.id, updatedBy: actor.id },
      { transaction }
    );

    return assignment.id;
  });

  const assignment = await RouteCollector.findByPk(assignmentId, {
    include: [
      { association: 'Collector', attributes: ['id', 'name', 'email', 'status'] },
      { association: 'Route', attributes: ['id', 'routeCode', 'name'] },
      { association: 'AssignedBy', attributes: ['id', 'name'] }
    ]
  });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ROUTE_ASSIGNED,
    entity: AUDIT_ENTITIES.ROUTE,
    entityId: Number(routeId),
    details: {
      assignmentType: 'COLLECTOR',
      routeCode: assignment.Route?.routeCode ?? null,
      collectorId: assignment.userId,
      collectorName: assignment.Collector?.name ?? null,
      assignedAt: assignment.assignedAt
    }
  });

  return assignment.toPublicJSON();
}

/** PATCH /api/admin/routes/:id/collectors/:assignmentId/status — soft unassign. */
async function changeCollectorAssignmentStatus(routeId, assignmentId, status, actor, context, { asOf = today() } = {}) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const assignment = await RouteCollector.findOne({
      where: { id: assignmentId, routeId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!assignment) {
      throw ApiError.notFound('Route collector assignment not found');
    }
    if (assignment.status === status) {
      return { assignment, changed: false };
    }

    if (status === ASSIGNMENT_STATUS.ACTIVE) {
      await assertAssignableCollector(assignment.userId, transaction);
      const clash = await RouteCollector.findOne({
        where: { routeId, userId: assignment.userId, status: ASSIGNMENT_STATUS.ACTIVE },
        transaction
      });
      if (clash) {
        throw ApiError.conflict('This collector already has an active assignment on this route');
      }
    }

    await assignment.update(
      {
        status,
        unassignedAt: status === ASSIGNMENT_STATUS.REMOVED ? asOf : null,
        updatedBy: actor.id
      },
      { transaction }
    );

    return { assignment, changed: true };
  });

  if (outcome.changed) {
    await auditService.record({
      ...context,
      action: status === ASSIGNMENT_STATUS.REMOVED ? AUDIT_ACTIONS.ROUTE_UNASSIGNED : AUDIT_ACTIONS.ROUTE_ASSIGNED,
      entity: AUDIT_ENTITIES.ROUTE,
      entityId: Number(routeId),
      details: { assignmentType: 'COLLECTOR', assignmentId: Number(assignmentId), collectorId: outcome.assignment.userId, status }
    });
  }

  const assignment = await RouteCollector.findByPk(assignmentId, {
    include: [
      { association: 'Collector', attributes: ['id', 'name', 'email', 'status'] },
      { association: 'Route', attributes: ['id', 'routeCode', 'name'] },
      { association: 'AssignedBy', attributes: ['id', 'name'] }
    ]
  });

  return assignment.toPublicJSON();
}

/**
 * POST /api/admin/routes/:id/loans
 * Moving a loan closes its previous assignment and opens a new one, so the
 * route it sat on at any past date remains recoverable.
 */
async function assignLoan(routeId, loanId, actor, context, { asOf = today() } = {}) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const route = await Route.findByPk(routeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!route) {
      throw ApiError.notFound('Route not found');
    }
    if (route.status !== ROUTE_STATUS.ACTIVE) {
      throw ApiError.conflict('Loans cannot be assigned to an inactive route');
    }

    const loan = await Loan.findByPk(loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) {
      throw ApiError.notFound('Loan not found');
    }

    const current = await LoanRoute.findOne({
      where: { loanId: loan.id, status: ASSIGNMENT_STATUS.ACTIVE },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (current && Number(current.routeId) === Number(route.id)) {
      throw ApiError.conflict('This loan is already assigned to this route');
    }

    let previousRouteId = null;
    if (current) {
      // Close the old period first: the unique generated column permits only
      // one ACTIVE row per loan.
      previousRouteId = current.routeId;
      await current.update({ status: ASSIGNMENT_STATUS.REMOVED, unassignedAt: asOf, updatedBy: actor.id }, { transaction });
    }

    const assignment = await LoanRoute.create(
      { loanId: loan.id, routeId: route.id, status: ASSIGNMENT_STATUS.ACTIVE, assignedAt: asOf, assignedBy: actor.id, updatedBy: actor.id },
      { transaction }
    );

    return { assignmentId: assignment.id, previousRouteId, loanNumber: loan.loanNumber, routeCode: route.routeCode };
  });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ROUTE_ASSIGNED,
    entity: AUDIT_ENTITIES.ROUTE,
    entityId: Number(routeId),
    details: {
      assignmentType: 'LOAN',
      routeCode: outcome.routeCode,
      loanId: Number(loanId),
      loanNumber: outcome.loanNumber,
      movedFromRouteId: outcome.previousRouteId,
      assignedAt: asOf
    }
  });

  const assignment = await LoanRoute.findByPk(outcome.assignmentId, {
    include: [
      { association: 'Route', attributes: ['id', 'routeCode', 'name', 'status'] },
      { association: 'Loan', attributes: ['id', 'loanNumber', 'status'] },
      { association: 'AssignedBy', attributes: ['id', 'name'] }
    ]
  });

  return assignment.toPublicJSON();
}

/** PATCH /api/admin/routes/:id/loans/:assignmentId/status — soft unassign. */
async function changeLoanAssignmentStatus(routeId, assignmentId, status, actor, context, { asOf = today() } = {}) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const assignment = await LoanRoute.findOne({ where: { id: assignmentId, routeId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!assignment) {
      throw ApiError.notFound('Loan route assignment not found');
    }
    if (assignment.status === status) {
      return { assignment, changed: false };
    }

    if (status === ASSIGNMENT_STATUS.ACTIVE) {
      const clash = await LoanRoute.findOne({
        where: { loanId: assignment.loanId, status: ASSIGNMENT_STATUS.ACTIVE },
        transaction
      });
      if (clash) {
        throw ApiError.conflict('This loan is already active on another route. Reassign it instead.');
      }
    }

    await assignment.update(
      { status, unassignedAt: status === ASSIGNMENT_STATUS.REMOVED ? asOf : null, updatedBy: actor.id },
      { transaction }
    );

    return { assignment, changed: true };
  });

  if (outcome.changed) {
    await auditService.record({
      ...context,
      action: status === ASSIGNMENT_STATUS.REMOVED ? AUDIT_ACTIONS.ROUTE_UNASSIGNED : AUDIT_ACTIONS.ROUTE_ASSIGNED,
      entity: AUDIT_ENTITIES.ROUTE,
      entityId: Number(routeId),
      details: { assignmentType: 'LOAN', assignmentId: Number(assignmentId), loanId: outcome.assignment.loanId, status }
    });
  }

  const assignment = await LoanRoute.findByPk(assignmentId, {
    include: [
      { association: 'Route', attributes: ['id', 'routeCode', 'name', 'status'] },
      { association: 'Loan', attributes: ['id', 'loanNumber', 'status'] },
      { association: 'AssignedBy', attributes: ['id', 'name'] }
    ]
  });

  return assignment.toPublicJSON();
}

/**
 * GET /api/admin/routes/:id/assignments
 * Full history — active and past — for both collectors and loans.
 */
async function getRouteAssignments(routeId, { includeRemoved = true } = {}, actor) {
  await assertRouteVisible(routeId, actor);
  await findRouteOrFail(routeId);

  const where = includeRemoved ? { routeId } : { routeId, status: ASSIGNMENT_STATUS.ACTIVE };

  const [collectors, loans] = await Promise.all([
    RouteCollector.findAll({
      where,
      include: [
        { association: 'Collector', attributes: ['id', 'name', 'email', 'status'] },
        { association: 'Route', attributes: ['id', 'routeCode', 'name'] },
        { association: 'AssignedBy', attributes: ['id', 'name'] }
      ],
      order: [['id', 'ASC']]
    }),
    LoanRoute.findAll({
      where,
      include: [
        { association: 'Route', attributes: ['id', 'routeCode', 'name', 'status'] },
        { association: 'Loan', attributes: ['id', 'loanNumber', 'status'] },
        { association: 'AssignedBy', attributes: ['id', 'name'] }
      ],
      order: [['id', 'ASC']]
    })
  ]);

  return {
    collectors: collectors.map((assignment) => assignment.toPublicJSON()),
    loans: loans.map((assignment) => assignment.toPublicJSON())
  };
}

module.exports = {
  listRoutes,
  getRouteById,
  createRoute,
  updateRoute,
  changeStatus,
  assignCollector,
  changeCollectorAssignmentStatus,
  assignLoan,
  changeLoanAssignmentStatus,
  getRouteAssignments,
  generateRouteCode,
  assertAssignableCollector,
  activeRouteIdsForCollector,
  isScopedActor,
  pickEditableFields,
  EDITABLE_FIELDS
};
