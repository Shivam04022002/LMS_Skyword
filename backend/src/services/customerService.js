'use strict';

const { Op } = require('sequelize');
const { sequelize, Customer, CifSequence } = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const { CIF_SEQUENCE_NAME, formatCifId, CUSTOMER_STATUS } = require('../config/customers');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

const SORTABLE_FIELDS = ['fullName', 'cifId', 'city', 'state', 'status', 'createdAt', 'updatedAt'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const AUDIT_INCLUDE = [
  { association: 'CreatedBy', attributes: ['id', 'name'] },
  { association: 'UpdatedBy', attributes: ['id', 'name'] }
];

/** Fields a client may supply. Everything else is backend-controlled. */
const EDITABLE_FIELDS = [
  'firstName',
  'middleName',
  'lastName',
  'mobile',
  'alternateMobile',
  'email',
  'dateOfBirth',
  'gender',
  'fatherName',
  'motherName',
  'maritalStatus',
  'occupation',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'pincode'
];

/** Copies only whitelisted fields — cifId, createdBy and timestamps can never arrive this way. */
function pickEditableFields(payload) {
  return EDITABLE_FIELDS.reduce((accumulator, field) => {
    if (payload[field] !== undefined) accumulator[field] = payload[field];
    return accumulator;
  }, {});
}

/**
 * Allocates the next CIFID.
 *
 * The counter row is read with `SELECT ... FOR UPDATE`, so a second concurrent
 * transaction blocks until the first commits or rolls back. Two customers can
 * therefore never receive the same number, and the UNIQUE index on `cif_id` is
 * the final backstop. Must be called inside the same transaction that inserts
 * the customer.
 */
async function generateCifId(transaction) {
  let sequence = await CifSequence.findOne({
    where: { name: CIF_SEQUENCE_NAME },
    transaction,
    lock: transaction.LOCK.UPDATE
  });

  // Self-healing if the migration's seed row is ever missing.
  if (!sequence) {
    sequence = await CifSequence.create({ name: CIF_SEQUENCE_NAME, currentNumber: 0 }, { transaction });
    sequence = await CifSequence.findOne({
      where: { name: CIF_SEQUENCE_NAME },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
  }

  const nextNumber = Number(sequence.currentNumber) + 1;
  await sequence.update({ currentNumber: nextNumber }, { transaction });

  return formatCifId(nextNumber);
}

async function findCustomerOrFail(customerId) {
  const customer = await Customer.findByPk(customerId, { include: AUDIT_INCLUDE });
  if (!customer) {
    throw ApiError.notFound('Customer not found');
  }
  return customer;
}

/**
 * GET /api/admin/customers
 * Search covers CIFID, full name, mobile and email; filtering and paging are
 * done in SQL, never in the client.
 */
async function listCustomers({ page = 1, limit = DEFAULT_LIMIT, search, status, city, state, gender, sortBy = 'createdAt', sortOrder = 'DESC' } = {}) {
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));

  const where = {};

  if (search && String(search).trim()) {
    const raw = String(search).trim();
    const term = `%${raw}%`;
    // A search that looks like a phone number is matched against the canonical
    // ten-digit form as well, so "+91 98765 43210" finds 9876543210.
    const digits = raw.replace(/\D/g, '');
    const conditions = [
      { cifId: { [Op.like]: term } },
      { fullName: { [Op.like]: term } },
      { mobile: { [Op.like]: term } },
      { email: { [Op.like]: term } }
    ];

    if (digits.length >= 4) {
      const digitTerm = `%${digits.slice(-10)}%`;
      conditions.push({ mobile: { [Op.like]: digitTerm } }, { alternateMobile: { [Op.like]: digitTerm } });
    }

    where[Op.or] = conditions;
  }

  if (status) where.status = status;
  if (city) where.city = city;
  if (state) where.state = state;
  if (gender) where.gender = gender;

  const field = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'createdAt';
  const direction = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const { rows, count } = await Customer.findAndCountAll({
    where,
    include: AUDIT_INCLUDE,
    order: [[field, direction]],
    limit: pageSize,
    offset: (currentPage - 1) * pageSize,
    distinct: true
  });

  return {
    customers: rows.map((customer) => customer.toPublicJSON()),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: count,
      totalPages: Math.ceil(count / pageSize) || 0
    }
  };
}

async function getCustomerById(customerId) {
  const customer = await findCustomerOrFail(customerId);
  return customer.toPublicJSON();
}

/**
 * POST /api/admin/customers
 *
 * CIFID allocation and the insert share one transaction: if the insert fails,
 * the counter increment rolls back with it, so a failed creation neither leaves
 * a gap nor burns a number. Duplicates are impossible.
 */
/**
 * Inserts one customer inside a caller-supplied transaction.
 *
 * The single-customer endpoint and the bulk import both come through here, so
 * CIFID allocation, the editable-field whitelist and the status default are the
 * same code in both paths and cannot drift apart. The transaction is the
 * caller's: the CIFID counter is locked within it, so concurrent creations —
 * one form submission and one import, or two imports — still serialise.
 */
async function createCustomerRecord(payload, actor, transaction) {
  const attributes = pickEditableFields(payload);
  const cifId = await generateCifId(transaction);

  return Customer.create(
    {
      ...attributes,
      cifId,
      status: payload.status ?? CUSTOMER_STATUS.ACTIVE,
      createdBy: actor.id,
      updatedBy: actor.id
    },
    { transaction }
  );
}

async function createCustomer(payload, actor, context) {
  const customerId = await sequelize.transaction(async (transaction) => {
    const created = await createCustomerRecord(payload, actor, transaction);
    return created.id;
  });

  const customer = await findCustomerOrFail(customerId);

  // Audited after commit so a rolled-back creation leaves no trail.
  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.CUSTOMER_CREATED,
    entity: AUDIT_ENTITIES.CUSTOMER,
    entityId: customer.id,
    details: { cifId: customer.cifId, fullName: customer.fullName, mobile: customer.mobile, status: customer.status }
  });

  return customer.toPublicJSON();
}

/**
 * PUT /api/admin/customers/:id
 * CIFID, createdBy and the timestamps are not in EDITABLE_FIELDS, so they
 * cannot be changed here regardless of what the request contains.
 */
async function updateCustomer(customerId, payload, actor, context) {
  const customer = await findCustomerOrFail(customerId);
  const attributes = pickEditableFields(payload);

  if (Object.keys(attributes).length === 0) {
    return customer.toPublicJSON();
  }

  await customer.update({ ...attributes, updatedBy: actor.id });

  const updated = await findCustomerOrFail(customerId);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
    entity: AUDIT_ENTITIES.CUSTOMER,
    entityId: updated.id,
    details: { cifId: updated.cifId, changed: Object.keys(attributes) }
  });

  return updated.toPublicJSON();
}

/**
 * PATCH /api/admin/customers/:id/status
 * Customers are never physically deleted — deactivation is the only removal.
 */
async function changeStatus(customerId, status, actor, context) {
  const customer = await findCustomerOrFail(customerId);

  if (customer.status === status) {
    return customer.toPublicJSON();
  }

  await customer.update({ status, updatedBy: actor.id });

  const updated = await findCustomerOrFail(customerId);

  await auditService.record({
    ...context,
    action: status === CUSTOMER_STATUS.ACTIVE ? AUDIT_ACTIONS.CUSTOMER_ACTIVATED : AUDIT_ACTIONS.CUSTOMER_DEACTIVATED,
    entity: AUDIT_ENTITIES.CUSTOMER,
    entityId: updated.id,
    details: { cifId: updated.cifId, status }
  });

  return updated.toPublicJSON();
}

module.exports = {
  createCustomerRecord,
  listCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  changeStatus,
  generateCifId,
  pickEditableFields,
  EDITABLE_FIELDS
};
