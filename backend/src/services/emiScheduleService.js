'use strict';

const { sequelize, Loan, EmiSchedule } = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const { calculateLoanFinancials, buildInstalmentPlan } = require('./loanCalculationService');
const { toPaise, fromPaise, divideRoundHalfUp } = require('../utils/money');
const { addDays, addMonths, today } = require('../utils/dates');
const { LOAN_TYPES, LOAN_STATUS, INTEREST_METHODS, WEEKLY_OFF } = require('../config/loans');
const { EMI_STATUS, DEFAULT_BOUNCE_CHARGE } = require('../config/emis');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

/**
 * Due date of instalment `emiNumber` (1-based).
 *
 * Always measured from the loan's start date rather than chained from the
 * previous instalment, so a 31st-of-the-month loan yields 02-28, 03-31, 04-30
 * instead of collapsing to the 28th after the first short month.
 */
function calculateEmiDate(startDate, loanType, emiNumber) {
  switch (loanType) {
    case LOAN_TYPES.DAILY:
      return addDays(startDate, emiNumber);
    case LOAN_TYPES.WEEKLY:
      return addDays(startDate, emiNumber * 7);
    case LOAN_TYPES.BI_WEEKLY:
      return addDays(startDate, emiNumber * 14);
    case LOAN_TYPES.MONTHLY:
      return addMonths(startDate, emiNumber);
    default:
      throw new TypeError(`Unknown loan type "${loanType}"`);
  }
}

/**
 * Every due date for a loan, in order.
 *
 * `offsets` comes from the calculation service whenever the loan states how
 * many collections it has: day offsets for a daily loan (skipping any excluded
 * weekday), multiples of 7 or 14 for a weekly or bi-weekly one. The schedule
 * and the quoted figures therefore rest on the same resolved set of periods
 * rather than two parallel rules. Without offsets the original per-type rule
 * applies, so nothing about an existing loan changes.
 */
function calculateEmiDates({ startDate, loanType, emiCount, offsets = null }) {
  if (offsets) {
    return offsets.map((offset) => addDays(startDate, offset));
  }
  return Array.from({ length: emiCount }, (_, index) => calculateEmiDate(startDate, loanType, index + 1));
}

/**
 * Splits a total into `count` parts that sum back to it exactly.
 *
 * Every part except the last is the rounded share; the last absorbs whatever
 * residue rounding produced. This is the same rule Phase 5 uses for
 * `lastEmiAmount`, so nothing is created or lost.
 */
function allocateEvenly(totalPaise, count) {
  const share = divideRoundHalfUp(totalPaise, BigInt(count));
  const parts = Array.from({ length: count - 1 }, () => share);
  const allocated = share * BigInt(count - 1);
  parts.push(totalPaise - allocated);
  return parts;
}

/** Interest per instalment, summing exactly to the total interest. */
function allocateInterest(totalInterest, emiCount) {
  return allocateEvenly(toPaise(totalInterest), emiCount).map(fromPaise);
}

/**
 * EMI amount per instalment.
 *
 * Uses the loan's stored `emiAmount` for every instalment but the last, so the
 * schedule agrees with the headline figure the borrower was quoted; the last
 * instalment carries the residue.
 */
function allocateEmiAmounts(totalRepayment, emiAmount, emiCount) {
  const totalPaise = toPaise(totalRepayment);
  const perEmiPaise = toPaise(emiAmount);
  const parts = Array.from({ length: emiCount - 1 }, () => perEmiPaise);
  parts.push(totalPaise - perEmiPaise * BigInt(emiCount - 1));
  return parts.map(fromPaise);
}

/**
 * Principal is the remainder of each instalment after interest.
 *
 * Deriving it this way rather than rounding it independently is what makes all
 * three totals reconcile at once: SUM(principal) = SUM(emi) - SUM(interest) =
 * totalRepayment - totalInterest = loanAmount, exactly.
 */
function allocatePrincipal(emiAmounts, interests) {
  return emiAmounts.map((emiAmount, index) => fromPaise(toPaise(emiAmount) - toPaise(interests[index])));
}

/** Rounding residue carried by the final instalment, relative to an even split. */
function calculateRounding({ totalRepayment, emiAmount, emiCount }) {
  const totalPaise = toPaise(totalRepayment);
  const evenPaise = toPaise(emiAmount) * BigInt(emiCount);
  return fromPaise(totalPaise - evenPaise);
}

/**
 * Refuses a schedule whose parts do not add back up to the loan.
 * Runs before any row is inserted, so a mis-allocation can never be persisted.
 */
function validateScheduleTotals(rows, { loanAmount, totalInterest, totalRepayment }) {
  const sum = (key) => rows.reduce((total, row) => total + toPaise(row[key]), 0n);

  const principalSum = sum('principal');
  const interestSum = sum('interest');
  const emiSum = sum('emiAmount');

  const mismatches = [];
  if (principalSum !== toPaise(loanAmount)) {
    mismatches.push(`principal ${fromPaise(principalSum)} != loan amount ${loanAmount}`);
  }
  if (interestSum !== toPaise(totalInterest)) {
    mismatches.push(`interest ${fromPaise(interestSum)} != total interest ${totalInterest}`);
  }
  if (emiSum !== toPaise(totalRepayment)) {
    mismatches.push(`instalments ${fromPaise(emiSum)} != total repayment ${totalRepayment}`);
  }

  if (mismatches.length > 0) {
    throw ApiError.internal(`Generated schedule does not reconcile: ${mismatches.join('; ')}`);
  }

  return { principal: fromPaise(principalSum), interest: fromPaise(interestSum), emiAmount: fromPaise(emiSum) };
}

/**
 * Builds the schedule rows for a loan. Pure — no database access — so it can be
 * tested and reconciled before anything is written.
 */
function buildSchedule(loan) {
  const emiCount = Number(loan.emiCount);
  if (!Number.isInteger(emiCount) || emiCount < 1) {
    throw ApiError.badRequest('This loan has no usable EMI count');
  }

  const interestMethod = loan.interestMethod ?? INTEREST_METHODS.FLAT;
  const weeklyOff = loan.weeklyOff ?? WEEKLY_OFF.NONE;

  /*
   * The formula is not restated here: the calculation service remains the
   * single authority for both methods. A FLAT loan is rebuilt from its STORED
   * totals, so a schedule generated today reproduces the figures the borrower
   * was quoted when the loan was created, whatever the defaults have since
   * become.
   */
  const { periods, offsets, summary } = buildInstalmentPlan({
    loanAmount: loan.loanAmount,
    roi: loan.roi,
    tenure: loan.tenure,
    loanType: loan.loanType,
    startDate: loan.startDate,
    interestMethod,
    weeklyOff,
    // The loan's own rate basis, so a legacy annual loan regenerates exactly
    // the schedule it was created with.
    roiBasis: loan.roiBasis,
    // The loan's own tenure unit, so a six-month daily contract regenerates the
    // same window and the same instalment dates.
    tenureUnit: loan.tenureUnit,
    // How many collections the contract is repaid in, when it states a number.
    collectionCount: loan.collectionCount,
    ...(interestMethod === INTEREST_METHODS.FLAT
      ? { totalRepayment: loan.totalRepayment, emiAmount: loan.emiAmount }
      : {})
  });

  if (periods.length !== emiCount) {
    throw ApiError.internal(
      `Schedule length ${periods.length} does not match the loan's EMI count ${emiCount}`
    );
  }

  const dates = calculateEmiDates({ startDate: loan.startDate, loanType: loan.loanType, emiCount, offsets });

  const rows = dates.map((emiDate, index) => ({
    loanId: loan.id,
    emiNumber: index + 1,
    emiDate,
    emiAmount: periods[index].emiAmount,
    principal: periods[index].principal,
    interest: periods[index].interest,
    dpd: 0,
    // Collections are Phase 7; a generated schedule always starts untouched.
    amountCollected: '0.00',
    paymentDate: null,
    status: EMI_STATUS.PENDING
  }));

  validateScheduleTotals(rows, {
    loanAmount: loan.loanAmount,
    totalInterest: summary.interest,
    totalRepayment: loan.totalRepayment
  });

  return { rows, totalInterest: summary.interest };
}

/**
 * Creates the schedule for a loan.
 *
 * Runs inside a transaction with the loan row locked, so two simultaneous
 * requests cannot both pass the "no schedule yet" check; UNIQUE(loan_id,
 * emi_number) is the database-level backstop. Idempotent by design: a loan that
 * already has a schedule is left exactly as it is.
 *
 * Pass an existing `transaction` to join the caller's unit of work — loan
 * activation does this, so the loan cannot become ACTIVE without its schedule.
 */
async function generateSchedule(loanId, actor, { transaction, conflictOnExisting = false } = {}) {
  const run = async (tx) => {
    const loan = await Loan.findByPk(loanId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!loan) {
      throw ApiError.notFound('Loan not found');
    }

    if (loan.status !== LOAN_STATUS.ACTIVE) {
      throw ApiError.conflict(
        `A schedule can only be generated for an ACTIVE loan (this loan is ${loan.status})`
      );
    }

    const existing = await EmiSchedule.count({ where: { loanId: loan.id }, transaction: tx });
    if (existing > 0) {
      if (conflictOnExisting) {
        throw ApiError.conflict(`This loan already has a schedule of ${existing} instalment(s)`);
      }
      // An existing schedule is financial history and is never rebuilt.
      return { loan, created: false, count: existing };
    }

    const { rows } = buildSchedule(loan);
    await EmiSchedule.bulkCreate(rows, { transaction: tx, validate: true });

    return { loan, created: true, count: rows.length };
  };

  const result = transaction ? await run(transaction) : await sequelize.transaction(run);

  if (result.created) {
    await auditService.record({
      actorId: actor?.id ?? null,
      ipAddress: actor?.ipAddress ?? null,
      action: AUDIT_ACTIONS.EMI_SCHEDULE_GENERATED,
      entity: AUDIT_ENTITIES.EMI_SCHEDULE,
      entityId: result.loan.id,
      details: {
        loanId: result.loan.id,
        loanNumber: result.loan.loanNumber,
        emiCount: result.count,
        generatedAt: new Date().toISOString()
      }
    });
  }

  return result;
}

async function assertLoanExists(loanId, transaction) {
  const loan = await Loan.findByPk(loanId, { transaction });
  if (!loan) {
    throw ApiError.notFound('Loan not found');
  }
  return loan;
}

/** GET — the schedule for a loan, with totals derived from the rows. */
async function listSchedule(loanId, { status, emiNumber, dateFrom, dateTo, page = 1, limit = 100 } = {}) {
  const loan = await assertLoanExists(loanId);

  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(limit) || 100));

  const where = { loanId: loan.id };
  if (emiNumber) where.emiNumber = Number(emiNumber);
  if (dateFrom || dateTo) {
    where.emiDate = {};
    if (dateFrom) where.emiDate[sequelize.Sequelize.Op.gte] = dateFrom;
    if (dateTo) where.emiDate[sequelize.Sequelize.Op.lte] = dateTo;
  }

  const asOf = today();

  // Every row is needed to derive accurate totals, and status is a derived
  // value that cannot be filtered in SQL against a stale snapshot.
  const allRows = await EmiSchedule.findAll({ where: { loanId: loan.id }, order: [['emiNumber', 'ASC']] });
  const summary = summarise(allRows, loan, asOf);

  const scoped = await EmiSchedule.findAll({ where, order: [['emiNumber', 'ASC']] });
  const filtered = status ? scoped.filter((row) => row.computeStatus(asOf) === status) : scoped;

  const offset = (currentPage - 1) * pageSize;
  const paged = filtered.slice(offset, offset + pageSize);

  return {
    emis: paged.map((row) => row.toPublicJSON(asOf)),
    summary,
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / pageSize) || 0
    }
  };
}

/** Loan-level totals, all derived from the schedule rows. */
function summarise(rows, loan, asOf = today()) {
  const sum = (mapper) => rows.reduce((total, row) => total + toPaise(mapper(row)), 0n);

  const collectedPaise = sum((row) => row.amountCollected ?? '0');
  const emiPaise = sum((row) => row.emiAmount);

  return {
    emiCount: rows.length,
    totalPrincipal: fromPaise(sum((row) => row.principal)),
    totalInterest: fromPaise(sum((row) => row.interest)),
    totalRepayment: fromPaise(emiPaise),
    totalCollected: fromPaise(collectedPaise),
    totalOutstanding: fromPaise(emiPaise - collectedPaise),
    overdueCount: rows.filter((row) => row.computeStatus(asOf) === EMI_STATUS.OVERDUE).length,
    paidCount: rows.filter((row) => row.computeStatus(asOf) === EMI_STATUS.PAID).length,
    maxDpd: rows.reduce((highest, row) => Math.max(highest, row.computeDpd(asOf)), 0),
    loanNumber: loan?.loanNumber ?? null,
    loanStatus: loan?.status ?? null
  };
}

async function getEmi(loanId, emiId) {
  await assertLoanExists(loanId);

  const emi = await EmiSchedule.findOne({ where: { id: emiId, loanId } });
  if (!emi) {
    throw ApiError.notFound('EMI not found on this loan');
  }

  return emi.toPublicJSON();
}

/**
 * Brings the stored `dpd` and `status` snapshots back in line with the derived
 * values. Nothing financial is altered — no amount, date or instalment count
 * changes — so this is safe to run at any time.
 */
async function recalculateSnapshots(loanId, actor, context) {
  const loan = await assertLoanExists(loanId);
  const asOf = today();

  const updated = await sequelize.transaction(async (transaction) => {
    const rows = await EmiSchedule.findAll({ where: { loanId: loan.id }, transaction, lock: transaction.LOCK.UPDATE });

    let changed = 0;
    for (const row of rows) {
      const dpd = row.computeDpd(asOf);
      const status = row.computeStatus(asOf);
      if (row.dpd !== dpd || row.status !== status) {
        await row.update({ dpd, status }, { transaction });
        changed += 1;
      }
    }

    return changed;
  });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.EMI_UPDATED,
    entity: AUDIT_ENTITIES.EMI_SCHEDULE,
    entityId: loan.id,
    details: { loanId: loan.id, loanNumber: loan.loanNumber, rowsUpdated: updated, asOf }
  });

  return listSchedule(loanId);
}

/**
 * Records the manual bounce charge on one instalment.
 *
 * Writes exactly one column. Nothing else on the row is read or touched — not
 * the amount, not the collected total, not the payment date, not DPD, not the
 * status — so this cannot move a single financial figure. There is no
 * recalculation afterwards for the same reason: there is nothing to recalculate.
 */
async function setBounceCharge(loanId, emiId, bounceCharge, actor, context) {
  const loan = await assertLoanExists(loanId);

  const emi = await EmiSchedule.findOne({ where: { id: emiId, loanId: loan.id } });
  if (!emi) {
    throw ApiError.notFound('EMI not found on this loan');
  }

  // Normalised through the same integer-paise path as every other amount, so
  // "500", "500.0" and "500.00" are all stored identically.
  const previous = emi.bounceCharge ?? DEFAULT_BOUNCE_CHARGE;
  const next = fromPaise(toPaise(String(bounceCharge)));

  await emi.update({ bounceCharge: next });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.EMI_BOUNCE_CHARGE_UPDATED,
    entity: AUDIT_ENTITIES.EMI_SCHEDULE,
    entityId: emi.id,
    details: {
      loanId: loan.id,
      loanNumber: loan.loanNumber,
      emiNumber: emi.emiNumber,
      previousBounceCharge: previous,
      bounceCharge: next
    }
  });

  return emi.toPublicJSON();
}

module.exports = {
  calculateEmiDate,
  calculateEmiDates,
  allocateEvenly,
  allocateInterest,
  allocateEmiAmounts,
  allocatePrincipal,
  calculateRounding,
  validateScheduleTotals,
  buildSchedule,
  generateSchedule,
  listSchedule,
  getEmi,
  summarise,
  recalculateSnapshots,
  setBounceCharge
};
