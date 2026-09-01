'use strict';

const { Op } = require('sequelize');
const {
  sequelize,
  Collection,
  CollectionAllocation,
  CollectionSequence,
  Loan,
  LoanParty,
  Customer,
  EmiSchedule
} = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const allocationService = require('./collectionAllocationService');
const { toPaise, fromPaise } = require('../utils/money');
const { today, differenceInDays } = require('../utils/dates');
const {
  formatCollectionNumber,
  COLLECTION_STATUS,
  LEDGER_TYPES_REQUIRING_REFERENCE,
  DEFAULT_BOUNCE_AMOUNT,
  emiPortionPaise
} = require('../config/collections');
const { LOAN_STATUS } = require('../config/loans');
const { PARTY_STATUS } = require('../config/loanParties');
const { EMI_STATUS } = require('../config/emis');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SORTABLE_FIELDS = ['collectionNumber', 'amount', 'collectionDate', 'status', 'createdAt'];

const DETAIL_INCLUDE = [
  { association: 'Loan', attributes: ['id', 'loanNumber', 'status'] },
  { association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile'] },
  { association: 'CreatedBy', attributes: ['id', 'name'] },
  { association: 'UpdatedBy', attributes: ['id', 'name'] },
  { association: 'Allocations', include: [{ association: 'Emi' }] }
];

const LIST_INCLUDE = [
  { association: 'Loan', attributes: ['id', 'loanNumber'] },
  { association: 'Customer', attributes: ['id', 'cifId', 'fullName'] },
  { association: 'CreatedBy', attributes: ['id', 'name'] }
];

/**
 * Allocates the next collection number for a year.
 *
 * The counter row is read with `SELECT ... FOR UPDATE` inside the posting
 * transaction — `MAX(collection_number) + 1` would race. UNIQUE(collection_number)
 * is the final backstop, and a rolled-back posting releases the number.
 */
async function generateCollectionNumber(year, transaction) {
  let sequence = await CollectionSequence.findOne({ where: { year }, transaction, lock: transaction.LOCK.UPDATE });

  if (!sequence) {
    await CollectionSequence.create({ year, currentNumber: 0 }, { transaction });
    sequence = await CollectionSequence.findOne({ where: { year }, transaction, lock: transaction.LOCK.UPDATE });
  }

  const nextNumber = Number(sequence.currentNumber) + 1;
  await sequence.update({ currentNumber: nextNumber }, { transaction });

  return formatCollectionNumber(year, nextNumber);
}

/** Money may only be taken against a live loan. */
function assertLoanAcceptsCollections(loan) {
  if (loan.status === LOAN_STATUS.ACTIVE) return;

  const reason =
    loan.status === LOAN_STATUS.CLOSED
      ? 'This loan is closed. A post-closure adjustment needs a controlled correction workflow.'
      : `Collections cannot be posted against a ${loan.status} loan.`;

  throw ApiError.conflict(reason);
}

/**
 * The payer must be a current party to the loan — applicant, co-applicant or
 * guarantor. Any of them may legitimately pay, so this is not restricted to the
 * applicant.
 */
async function assertCustomerIsLoanParty(loanId, customerId, transaction) {
  const customer = await Customer.findByPk(customerId, { transaction });
  if (!customer) {
    throw ApiError.notFound('Customer not found');
  }

  const party = await LoanParty.findOne({
    where: { loanId, customerId, status: PARTY_STATUS.ACTIVE },
    transaction
  });

  if (!party) {
    throw ApiError.badRequest(`Customer ${customer.cifId} is not a party to this loan`);
  }

  return { customer, party };
}

/** A bank transfer must be traceable; cash need not be. */
function assertPaymentReference(ledgerType, paymentReference) {
  if (LEDGER_TYPES_REQUIRING_REFERENCE.includes(ledgerType) && !String(paymentReference ?? '').trim()) {
    throw ApiError.badRequest(`A payment reference is required for ${ledgerType} collections`);
  }
}

/** Advance collections are not supported, so a future date is refused. */
function assertCollectionDate(collectionDate, asOf = today()) {
  if (differenceInDays(collectionDate, asOf) < 0) {
    throw ApiError.badRequest('The collection date cannot be in the future');
  }
}

/**
 * BOUNCE COLLECTION — the part of this payment that was received against a
 * bounce charge rather than an instalment.
 *
 * It is taken OUT of the amount, never added on top of it: the customer handed
 * over `amount`, and this says how that total splits. Bounce above the amount
 * would be money the customer never paid, so it is refused.
 *
 * Returns the instalment portion, in paise — what the allocations must total.
 */
function assertBounceAmount(amount, bounceAmount = DEFAULT_BOUNCE_AMOUNT) {
  const bouncePaise = toPaise(bounceAmount ?? DEFAULT_BOUNCE_AMOUNT);

  if (bouncePaise < 0n) {
    throw ApiError.badRequest('The bounce collection cannot be negative');
  }

  const emiPaise = emiPortionPaise(amount, bounceAmount ?? DEFAULT_BOUNCE_AMOUNT);
  if (emiPaise < 0n) {
    throw ApiError.badRequest(
      `The bounce collection ${fromPaise(bouncePaise)} is more than the ${amount} received. ` +
        'Bounce is part of the collection amount, not an addition to it.'
    );
  }

  return emiPaise;
}

async function findCollectionOrFail(collectionId) {
  const collection = await Collection.findByPk(collectionId, { include: DETAIL_INCLUDE });
  if (!collection) {
    throw ApiError.notFound('Collection not found');
  }
  return collection;
}

/**
 * POST /api/admin/collections
 *
 * One transaction covers the number, the collection, every allocation and the
 * recalculation of each affected instalment. Any failure rolls all of it back,
 * so a partially applied payment cannot exist.
 *
 * The affected instalment rows are locked before their outstanding balances are
 * read, which is what stops two collectors from between them over-collecting a
 * single instalment.
 */
/**
 * Posts one collection inside a caller-supplied transaction.
 *
 * The single Post Collection endpoint and the bulk import both come through
 * here, so the eligibility rules, the allocation validation, the collection
 * number and the snapshot rebuild are the same code in both paths and cannot
 * drift apart. The transaction is the caller's, which is what lets an import
 * post a whole batch atomically.
 */
async function createCollectionRecord(payload, actor, transaction, { asOf = today() } = {}) {
  const {
    loanId,
    customerId,
    amount,
    // How much of `amount` was received against a bounce charge. Absent on
    // every existing caller — the manual form before this feature, both
    // importers, oneBulk — and absent means 0.00, i.e. the previous behaviour
    // exactly.
    bounceAmount = DEFAULT_BOUNCE_AMOUNT,
    collectionDate,
    ledgerType,
    paymentReference = null,
    notes = null,
    allocations
  } = payload;

  assertPaymentReference(ledgerType, paymentReference);
  assertCollectionDate(collectionDate, asOf);

  if (toPaise(amount) <= 0n) {
    throw ApiError.badRequest('The collection amount must be greater than zero');
  }

  // The instalment portion: amount - bounce. Allocations must total this, which
  // is what keeps bounce out of principal, interest and every EMI balance while
  // still accounting for every rupee received.
  const emiPaise = assertBounceAmount(amount, bounceAmount);

  const loan = await Loan.findByPk(loanId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!loan) {
    throw ApiError.notFound('Loan not found');
  }

  assertLoanAcceptsCollections(loan);
  await assertCustomerIsLoanParty(loan.id, customerId, transaction);

  // Locks the instalments and validates every allocation against their
  // current outstanding balances.
  const { planned, emiIds } = await allocationService.validateAllocations({
    allocations,
    collectionAmount: fromPaise(emiPaise),
    loanId: loan.id,
    transaction
  });

  const year = new Date().getFullYear();
  const collectionNumber = await generateCollectionNumber(year, transaction);

  const collection = await Collection.create(
    {
      collectionNumber,
      loanId: loan.id,
      customerId,
      amount,
      bounceAmount: fromPaise(toPaise(bounceAmount ?? DEFAULT_BOUNCE_AMOUNT)),
      collectionDate,
      ledgerType,
      paymentReference: paymentReference || null,
      notes: notes || null,
      status: COLLECTION_STATUS.POSTED,
      createdBy: actor.id,
      updatedBy: actor.id
    },
    { transaction }
  );

  await CollectionAllocation.bulkCreate(
    planned.map((allocation) => ({ ...allocation, collectionId: collection.id })),
    { transaction, validate: true }
  );

  // Snapshots are rebuilt from the ledger, not incremented.
  await allocationService.recalculateEmis(emiIds, transaction, asOf);

  return collection;
}

async function createCollection(payload, actor, context, { asOf = today() } = {}) {
  const collectionId = await sequelize.transaction(
    async (transaction) => (await createCollectionRecord(payload, actor, transaction, { asOf })).id
  );

  const collection = await findCollectionOrFail(collectionId);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.COLLECTION_CREATED,
    entity: AUDIT_ENTITIES.COLLECTION,
    entityId: collection.id,
    details: {
      collectionNumber: collection.collectionNumber,
      loanId: collection.loanId,
      loanNumber: collection.Loan?.loanNumber ?? null,
      amount: collection.amount,
      // Recorded through the existing audit mechanism, in the existing details
      // blob: the split of the amount above, not a second amount.
      emiCollected: collection.emiCollected(),
      bounceCollected: collection.bounceAmount,
      ledgerType: collection.ledgerType,
      collectionDate: collection.collectionDate,
      allocations: collection.Allocations.map((allocation) => ({
        emiNumber: allocation.Emi?.emiNumber ?? null,
        amount: allocation.allocatedAmount
      }))
    }
  });

  return collection.toPublicJSON();
}

/**
 * POST /api/admin/collections/:id/reverse
 *
 * Marks the collection REVERSED and rebuilds the affected instalments from the
 * remaining POSTED allocations. The collection and its allocation rows are kept
 * — the history stays readable — they simply stop counting.
 *
 * The collection row is locked first, so two simultaneous reversals cannot both
 * succeed: the second sees REVERSED and gets a conflict.
 */
async function reverseCollection(collectionId, reason, actor, context, { asOf = today() } = {}) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const collection = await Collection.findByPk(collectionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!collection) {
      throw ApiError.notFound('Collection not found');
    }

    if (collection.status !== COLLECTION_STATUS.POSTED) {
      throw ApiError.conflict('This collection has already been reversed');
    }

    const allocations = await CollectionAllocation.findAll({
      where: { collectionId: collection.id },
      transaction
    });
    const emiIds = allocations.map((allocation) => allocation.emiId);

    // Lock the affected instalments before their balances change.
    await allocationService.lockEmis(emiIds, transaction);

    await collection.update(
      {
        status: COLLECTION_STATUS.REVERSED,
        notes: reason ? `${collection.notes ? `${collection.notes}\n` : ''}Reversal reason: ${reason}` : collection.notes,
        updatedBy: actor.id
      },
      { transaction }
    );

    // With the collection no longer POSTED its allocations stop counting, so a
    // plain rebuild restores the correct balances, statuses, DPD and payment
    // dates without any of it being hardcoded.
    await allocationService.recalculateEmis(emiIds, transaction, asOf);

    return {
      collectionId: collection.id,
      collectionNumber: collection.collectionNumber,
      amount: collection.amount,
      // Reversal removes the bounce component with the rest of the payment: the
      // row stops being POSTED, so every bounce total that filters on POSTED
      // drops it, exactly as it drops the instalment money.
      bounceAmount: collection.bounceAmount,
      emiIds
    };
  });

  const collection = await findCollectionOrFail(outcome.collectionId);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.COLLECTION_REVERSED,
    entity: AUDIT_ENTITIES.COLLECTION,
    entityId: outcome.collectionId,
    details: {
      collectionNumber: outcome.collectionNumber,
      loanNumber: collection.Loan?.loanNumber ?? null,
      amount: outcome.amount,
      bounceCollected: outcome.bounceAmount,
      affectedEmiCount: outcome.emiIds.length,
      reason: reason ?? null
    }
  });

  return collection.toPublicJSON();
}

async function getCollection(collectionId) {
  const collection = await findCollectionOrFail(collectionId);
  return collection.toPublicJSON();
}

/** GET /api/admin/collections — server-side search, filters and paging. */
async function listCollections({
  page = 1,
  limit = DEFAULT_LIMIT,
  search,
  status,
  ledgerType,
  loanId,
  createdBy,
  dateFrom,
  dateTo,
  sortBy = 'collectionDate',
  sortOrder = 'DESC'
} = {}) {
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));

  const where = {};
  if (status) where.status = status;
  if (ledgerType) where.ledgerType = ledgerType;
  if (loanId) where.loanId = Number(loanId);
  if (createdBy) where.createdBy = Number(createdBy);

  if (dateFrom || dateTo) {
    where.collectionDate = {};
    if (dateFrom) where.collectionDate[Op.gte] = dateFrom;
    if (dateTo) where.collectionDate[Op.lte] = dateTo;
  }

  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    where[Op.or] = [
      { collectionNumber: { [Op.like]: term } },
      { '$Loan.loan_number$': { [Op.like]: term } },
      { '$Customer.cif_id$': { [Op.like]: term } },
      { '$Customer.full_name$': { [Op.like]: term } }
    ];
  }

  const field = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'collectionDate';
  const direction = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const { rows, count } = await Collection.findAndCountAll({
    where,
    include: LIST_INCLUDE,
    order: [[field, direction], ['id', 'DESC']],
    limit: pageSize,
    offset: (currentPage - 1) * pageSize,
    // belongsTo joins only, so a single query is correct here.
    subQuery: false,
    distinct: true
  });

  return {
    collections: rows.map((collection) => collection.toListJSON()),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: count,
      totalPages: Math.ceil(count / pageSize) || 0
    }
  };
}

/**
 * Payment position of a loan.
 *
 * Everything is derived from the instalment rows, which are themselves derived
 * from the allocation ledger. There is no separate mutable "loan outstanding"
 * column to drift out of step.
 */
async function getLoanCollectionSummary(loanId, { asOf = today() } = {}) {
  const loan = await Loan.findByPk(loanId);
  if (!loan) {
    throw ApiError.notFound('Loan not found');
  }

  const emis = await EmiSchedule.findAll({ where: { loanId }, order: [['emiNumber', 'ASC']] });

  const sum = (mapper) => emis.reduce((total, emi) => total + toPaise(mapper(emi)), 0n);

  const totalRepaymentPaise = sum((emi) => emi.emiAmount);
  const totalCollectedPaise = sum((emi) => emi.amountCollected ?? '0');

  const statuses = emis.map((emi) => emi.computeStatus(asOf));

  const postedCount = await Collection.count({ where: { loanId, status: COLLECTION_STATUS.POSTED } });
  const reversedCount = await Collection.count({ where: { loanId, status: COLLECTION_STATUS.REVERSED } });

  /*
   * Bounce, reported beside the instalment position rather than inside it.
   *
   *   bounceCharged   what has been ASSESSED on this loan's instalments
   *   bounceCollected what has actually been RECEIVED against those charges
   *
   * The two come from different places on purpose: the first is typed in by an
   * operator on an instalment, the second only moves when a collection is
   * posted. Neither touches totalRepayment, totalCollected or
   * totalOutstanding above — those stay exactly the instalment figures they
   * have always been.
   */
  const { bounceCollection } = await allocationService.bounceCollected({ loanId, status: COLLECTION_STATUS.POSTED });
  const bounceChargedPaise = sum((emi) => emi.bounceCharge ?? '0');
  const bounceCollectedPaise = toPaise(bounceCollection);

  return {
    loanNumber: loan.loanNumber,
    loanStatus: loan.status,
    totalRepayment: fromPaise(totalRepaymentPaise),
    totalCollected: fromPaise(totalCollectedPaise),
    totalOutstanding: fromPaise(totalRepaymentPaise - totalCollectedPaise),
    emiCount: emis.length,
    paidEmiCount: statuses.filter((status) => status === EMI_STATUS.PAID).length,
    partialEmiCount: statuses.filter((status) => status === EMI_STATUS.PARTIAL).length,
    overdueEmiCount: statuses.filter((status) => status === EMI_STATUS.OVERDUE).length,
    remainingEmiCount: statuses.filter((status) => status !== EMI_STATUS.PAID && status !== EMI_STATUS.WAIVED).length,
    maxDpd: emis.reduce((highest, emi) => Math.max(highest, emi.computeDpd(asOf)), 0),
    postedCollectionCount: postedCount,
    reversedCollectionCount: reversedCount,
    // "Bounce Charge" is what is owed; "Bounce Collection" is what was paid.
    bounceCharged: fromPaise(bounceChargedPaise),
    bounceCollected: fromPaise(bounceCollectedPaise),
    bounceOutstanding: fromPaise(
      bounceChargedPaise - bounceCollectedPaise > 0n ? bounceChargedPaise - bounceCollectedPaise : 0n
    )
  };
}

module.exports = {
  assertLoanAcceptsCollections,
  assertPaymentReference,
  assertCollectionDate,
  assertBounceAmount,
  createCollectionRecord,
  createCollection,
  reverseCollection,
  getCollection,
  listCollections,
  getLoanCollectionSummary,
  generateCollectionNumber,
  assertLoanAcceptsCollections,
  assertCustomerIsLoanParty,
  assertPaymentReference,
  assertCollectionDate
};
