'use strict';

const { Op } = require('sequelize');
const { sequelize, Loan, LoanSequence, LoanParty, Customer } = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const loanPartyService = require('./loanPartyService');
const loanStatusService = require('./loanStatusService');
const emiScheduleService = require('./emiScheduleService');
const { calculateLoanFinancials } = require('./loanCalculationService');
const {
  formatLoanNumber,
  LOAN_STATUS,
  FINANCIAL_FIELDS,
  INTEREST_METHODS,
  WEEKLY_OFF,
  DEFAULT_ROI_BASIS,
  DEFAULT_TENURE_UNIT
} = require('../config/loans');
const { PARTY_ROLES, PARTY_STATUS, isPrimaryRole } = require('../config/loanParties');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SORTABLE_FIELDS = ['loanNumber', 'loanAmount', 'startDate', 'status', 'createdAt', 'updatedAt'];

const PARTY_INCLUDE = {
  association: 'Parties',
  include: [{ association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile', 'status'] }]
};

const DETAIL_INCLUDE = [
  PARTY_INCLUDE,
  { association: 'CreatedBy', attributes: ['id', 'name'] },
  { association: 'UpdatedBy', attributes: ['id', 'name'] }
];

/**
 * Allocates the next loan number for a year.
 *
 * The counter row is read with `SELECT ... FOR UPDATE` inside the loan's own
 * transaction, so a concurrent creation blocks until this one commits or rolls
 * back — `MAX(loan_number) + 1` would race here. UNIQUE(loan_number) is the
 * final backstop. A rolled-back creation releases the number, so gaps only
 * appear if a commit later fails; duplicates cannot occur at all.
 */
async function generateLoanNumber(year, transaction) {
  let sequence = await LoanSequence.findOne({ where: { year }, transaction, lock: transaction.LOCK.UPDATE });

  // First loan of a new year — self-healing if the row was never seeded.
  if (!sequence) {
    await LoanSequence.create({ year, currentNumber: 0 }, { transaction });
    sequence = await LoanSequence.findOne({ where: { year }, transaction, lock: transaction.LOCK.UPDATE });
  }

  const nextNumber = Number(sequence.currentNumber) + 1;
  await sequence.update({ currentNumber: nextNumber }, { transaction });

  return formatLoanNumber(year, nextNumber);
}

async function findLoanOrFail(loanId, options = {}) {
  const loan = await Loan.findByPk(loanId, { include: DETAIL_INCLUDE, ...options });
  if (!loan) {
    throw ApiError.notFound('Loan not found');
  }
  return loan;
}

/**
 * Resolves and validates every customer that will be attached to a loan.
 * Reuses the Phase 4 rules rather than restating them: the customer must exist
 * and be active, nobody may appear twice, and there is exactly one applicant.
 */
async function resolveParties({ applicantCustomerId, coApplicantCustomerIds = [], guarantorCustomerIds = [] }, transaction) {
  if (!applicantCustomerId) {
    throw ApiError.badRequest('A loan requires exactly one applicant');
  }

  const requested = [
    { customerId: applicantCustomerId, partyRole: PARTY_ROLES.APPLICANT },
    ...coApplicantCustomerIds.map((customerId) => ({ customerId, partyRole: PARTY_ROLES.CO_APPLICANT })),
    ...guarantorCustomerIds.map((customerId) => ({ customerId, partyRole: PARTY_ROLES.GUARANTOR }))
  ];

  const seen = new Map();
  const resolved = [];

  for (const entry of requested) {
    const customer = await loanPartyService.resolveCustomer({ customerId: entry.customerId }, transaction);
    loanPartyService.assertCustomerAssignable(customer);

    // One customer holds one role per loan — never applicant and guarantor.
    if (seen.has(customer.id)) {
      throw ApiError.conflict(
        `Customer ${customer.cifId} cannot hold more than one role on a loan (already ${seen.get(customer.id)})`
      );
    }
    seen.set(customer.id, entry.partyRole);

    resolved.push({ customer, partyRole: entry.partyRole });
  }

  return resolved;
}

/** GET /api/admin/loans */
async function listLoans({ page = 1, limit = DEFAULT_LIMIT, search, status, loanType, startDateFrom, startDateTo, sortBy = 'createdAt', sortOrder = 'DESC' } = {}) {
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));

  const where = {};

  if (status) where.status = status;
  if (loanType) where.loanType = loanType;

  if (startDateFrom || startDateTo) {
    where.startDate = {};
    if (startDateFrom) where.startDate[Op.gte] = startDateFrom;
    if (startDateTo) where.startDate[Op.lte] = startDateTo;
  }

  if (search && String(search).trim()) {
    const raw = String(search).trim();
    const term = `%${raw}%`;

    // Customer-side matches are resolved to loan ids first, so the main query
    // stays a simple indexed lookup instead of a filtered join.
    const digits = raw.replace(/\D/g, '');
    const customerConditions = [
      { '$Customer.cif_id$': { [Op.like]: term } },
      { '$Customer.full_name$': { [Op.like]: term } }
    ];
    if (digits.length >= 4) {
      customerConditions.push({ '$Customer.mobile$': { [Op.like]: `%${digits.slice(-10)}%` } });
    }

    const matchingParties = await LoanParty.findAll({
      attributes: ['loanId'],
      include: [{ association: 'Customer', attributes: [] }],
      where: { [Op.or]: customerConditions },
      group: ['loanId'],
      raw: true
    });

    const loanIds = matchingParties.map((row) => row.loanId);

    where[Op.or] = [{ loanNumber: { [Op.like]: term } }, ...(loanIds.length > 0 ? [{ id: { [Op.in]: loanIds } }] : [])];
  }

  const field = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'createdAt';
  const direction = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const { rows, count } = await Loan.findAndCountAll({
    where,
    include: [PARTY_INCLUDE],
    order: [[field, direction]],
    limit: pageSize,
    offset: (currentPage - 1) * pageSize,
    distinct: true
  });

  return {
    loans: rows.map((loan) => loan.toListJSON()),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: count,
      totalPages: Math.ceil(count / pageSize) || 0
    }
  };
}

async function getLoanById(loanId) {
  const loan = await findLoanOrFail(loanId);
  return loan.toPublicJSON();
}

/**
 * Creates one loan and its parties inside a caller-supplied transaction.
 *
 * The single-loan endpoint and the bulk import both come through here, so the
 * financial calculation, the loan-number allocation and the party rules are the
 * same code in both paths and cannot drift apart. The transaction is the
 * caller's: the loan-number counter is locked within it, so concurrent
 * creations still serialise.
 */
async function createLoanRecord(payload, actor, transaction) {
  const { loanAmount, roi, tenure, loanType, startDate } = payload;
  const interestMethod = payload.interestMethod ?? INTEREST_METHODS.FLAT;
  const weeklyOff = payload.weeklyOff ?? WEEKLY_OFF.NONE;
  const roiBasis = DEFAULT_ROI_BASIS;
  const tenureUnit = payload.tenureUnit ?? DEFAULT_TENURE_UNIT;
  const collectionCount = payload.collectionCount ?? null;

  const financials = calculateLoanFinancials({
    loanAmount,
    roi,
    tenure,
    loanType,
    startDate,
    interestMethod,
    weeklyOff,
    roiBasis,
    tenureUnit,
    collectionCount
  });

  const parties = await resolveParties(payload, transaction);

  const year = new Date().getFullYear();
  const loanNumber = await generateLoanNumber(year, transaction);

  const loan = await Loan.create(
    {
      loanNumber,
      loanAmount,
      roi,
      roiBasis,
      tenure,
      tenureUnit,
      collectionCount,
      loanType,
      interestMethod,
      weeklyOff,
      startDate,
      totalRepayment: financials.totalRepayment,
      emiAmount: financials.emiAmount,
      emiCount: financials.emiCount,
      status: LOAN_STATUS.DRAFT,
      createdBy: actor.id,
      updatedBy: actor.id
    },
    { transaction }
  );

  await LoanParty.bulkCreate(
    parties.map(({ customer, partyRole }) => ({
      loanId: loan.id,
      customerId: customer.id,
      partyRole,
      isPrimary: isPrimaryRole(partyRole),
      status: PARTY_STATUS.ACTIVE,
      createdBy: actor.id,
      updatedBy: actor.id
    })),
    { transaction, validate: true, individualHooks: true }
  );

  return loan;
}

/**
 * POST /api/admin/loans
 *
 * One transaction covers number allocation, the loan row and every party row.
 * Any failure rolls all of it back — a partially created loan cannot survive.
 * All financial values are computed here; client-supplied totals are rejected
 * by the validator and never read.
 */
async function createLoan(payload, actor, context) {
  const { loanAmount, roi, tenure, loanType, startDate } = payload;
  // Both are stored on the loan, so a later change of the system default can
  // never re-price this agreement.
  const interestMethod = payload.interestMethod ?? INTEREST_METHODS.FLAT;
  const weeklyOff = payload.weeklyOff ?? WEEKLY_OFF.NONE;
  // The rate basis is a system rule, not a client choice: a new loan is always
  // priced on the current one, and it is recorded so it stays that way.
  const roiBasis = DEFAULT_ROI_BASIS;
  const tenureUnit = payload.tenureUnit ?? DEFAULT_TENURE_UNIT;
  const collectionCount = payload.collectionCount ?? null;

  // Computed before the transaction opens: a bad input should not hold locks.
  const financials = calculateLoanFinancials({
    loanAmount,
    roi,
    tenure,
    loanType,
    startDate,
    interestMethod,
    weeklyOff,
    roiBasis,
    tenureUnit,
    collectionCount
  });

  const loanId = await sequelize.transaction(async (transaction) =>
    (await createLoanRecord(payload, actor, transaction)).id
  );

  const loan = await findLoanOrFail(loanId);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.LOAN_CREATED,
    entity: AUDIT_ENTITIES.LOAN,
    entityId: loan.id,
    details: {
      loanNumber: loan.loanNumber,
      loanAmount: loan.loanAmount,
      roi: loan.roi,
      roiBasis: loan.roiBasis,
      tenure: loan.tenure,
      tenureUnit: loan.tenureUnit,
      collectionCount: loan.collectionCount,
      loanType: loan.loanType,
      interestMethod: loan.interestMethod,
      weeklyOff: loan.weeklyOff,
      totalRepayment: loan.totalRepayment,
      emiAmount: loan.emiAmount,
      emiCount: loan.emiCount,
      applicantCif: loan.applicant()?.Customer?.cifId ?? null
    }
  });

  return loan.toPublicJSON();
}

/**
 * PUT /api/admin/loans/:id
 * Only a DRAFT loan's terms may be revised; the status service enforces that
 * independently of anything the UI allows. Changing terms recomputes the
 * financials — they are never taken from the request.
 */
async function updateLoan(loanId, payload, actor, context) {
  const requestedFields = FINANCIAL_FIELDS.filter((field) => payload[field] !== undefined);

  const updatedId = await sequelize.transaction(async (transaction) => {
    const loan = await Loan.findByPk(loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) {
      throw ApiError.notFound('Loan not found');
    }

    loanStatusService.assertEditable(loan, requestedFields);

    if (requestedFields.length === 0) {
      return loan.id;
    }

    const terms = {
      loanAmount: payload.loanAmount ?? loan.loanAmount,
      roi: payload.roi ?? loan.roi,
      tenure: payload.tenure ?? loan.tenure,
      loanType: payload.loanType ?? loan.loanType,
      interestMethod: payload.interestMethod ?? loan.interestMethod,
      weeklyOff: payload.weeklyOff ?? loan.weeklyOff,
      // Never re-interpret an existing loan's rate: a DRAFT priced on an annual
      // rate stays annual, even while new loans are quoted monthly.
      roiBasis: loan.roiBasis,
      tenureUnit: payload.tenureUnit ?? loan.tenureUnit,
      collectionCount: payload.collectionCount !== undefined ? payload.collectionCount : loan.collectionCount
    };

    const startDate = payload.startDate ?? loan.startDate;

    // The chargeable-day count depends on the start date, so it is part of the
    // recalculation even when only the date moved.
    const financials = calculateLoanFinancials({ ...terms, startDate });

    await loan.update(
      {
        ...terms,
        startDate,
        totalRepayment: financials.totalRepayment,
        emiAmount: financials.emiAmount,
        emiCount: financials.emiCount,
        updatedBy: actor.id
      },
      { transaction }
    );

    return loan.id;
  });

  const loan = await findLoanOrFail(updatedId);

  if (requestedFields.length > 0) {
    await auditService.record({
      ...context,
      action: AUDIT_ACTIONS.LOAN_UPDATED,
      entity: AUDIT_ENTITIES.LOAN,
      entityId: loan.id,
      details: {
        loanNumber: loan.loanNumber,
        changed: requestedFields,
        totalRepayment: loan.totalRepayment,
        emiAmount: loan.emiAmount
      }
    });
  }

  return loan.toPublicJSON();
}

/** PATCH /api/admin/loans/:id/status */
async function changeStatus(loanId, status, actor, context) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const loan = await Loan.findByPk(loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) {
      throw ApiError.notFound('Loan not found');
    }

    const previousStatus = loan.status;
    loanStatusService.assertTransitionAllowed(previousStatus, status);

    // A loan must have its applicant before it can go live.
    if (status === LOAN_STATUS.ACTIVE) {
      const applicantCount = await LoanParty.count({
        where: { loanId: loan.id, partyRole: PARTY_ROLES.APPLICANT, status: PARTY_STATUS.ACTIVE },
        transaction
      });
      if (applicantCount !== 1) {
        throw ApiError.conflict('A loan needs exactly one applicant before it can be activated');
      }
    }

    await loan.update({ status, updatedBy: actor.id }, { transaction });

    // Activation and schedule generation share this transaction: a loan can
    // never become ACTIVE without its schedule, and a schedule failure rolls the
    // activation back with it. Closing or cancelling generates nothing, and an
    // existing schedule is left untouched as financial history.
    let scheduleGenerated = 0;
    if (status === LOAN_STATUS.ACTIVE) {
      await loan.reload({ transaction });
      const schedule = await emiScheduleService.generateSchedule(loan.id, actor, { transaction });
      scheduleGenerated = schedule.created ? schedule.count : 0;
    }

    return { loanId: loan.id, previousStatus, loanNumber: loan.loanNumber, scheduleGenerated };
  });

  await auditService.record({
    ...context,
    action: loanStatusService.auditActionForTransition(status),
    entity: AUDIT_ENTITIES.LOAN,
    entityId: outcome.loanId,
    details: {
      loanNumber: outcome.loanNumber,
      from: outcome.previousStatus,
      to: status,
      ...(outcome.scheduleGenerated ? { emiScheduleGenerated: outcome.scheduleGenerated } : {})
    }
  });

  const loan = await findLoanOrFail(outcome.loanId);
  return loan.toPublicJSON();
}

module.exports = {
  createLoanRecord,
  listLoans,
  getLoanById,
  createLoan,
  updateLoan,
  changeStatus,
  generateLoanNumber,
  resolveParties
};
