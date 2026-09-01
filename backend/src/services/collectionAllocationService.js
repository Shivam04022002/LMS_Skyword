'use strict';

const { fn, col, literal } = require('sequelize');
const { EmiSchedule, CollectionAllocation, Collection } = require('../models');
const ApiError = require('../utils/ApiError');
const { toPaise, fromPaise, divideRoundHalfUp } = require('../utils/money');
const { today } = require('../utils/dates');
const { COLLECTION_STATUS, MAX_ALLOCATIONS_PER_COLLECTION } = require('../config/collections');

/**
 * Allocation mechanics.
 *
 * The allocation rows are the ledger and the only authority on what an
 * instalment has been paid. `emi_schedules.amount_collected`, `payment_date`,
 * `status` and `dpd` are snapshots recomputed from that ledger — never
 * incremented in place — which is what makes reversal exactly correct rather
 * than approximately correct.
 */

/**
 * Locks the given instalments for the rest of the transaction.
 * Ordered by id so concurrent postings always take locks in the same sequence,
 * which is what keeps two collectors from deadlocking against each other.
 */
async function lockEmis(emiIds, transaction) {
  const ordered = [...new Set(emiIds.map(Number))].sort((a, b) => a - b);

  const emis = await EmiSchedule.findAll({
    where: { id: ordered },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE
  });

  const found = new Map(emis.map((emi) => [emi.id, emi]));
  const missing = ordered.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw ApiError.notFound(`Unknown instalment(s): ${missing.join(', ')}`);
  }

  return { emis, byId: found, orderedIds: ordered };
}

/**
 * Money already collected against each instalment, taken from POSTED
 * collections only. Reversed collections contribute nothing.
 */
async function calculateCollectedByEmi(emiIds, transaction) {
  if (emiIds.length === 0) return new Map();

  const rows = await CollectionAllocation.findAll({
    attributes: ['emiId', [fn('SUM', col('allocated_amount')), 'total']],
    include: [
      {
        association: 'Collection',
        attributes: [],
        where: { status: COLLECTION_STATUS.POSTED },
        required: true
      }
    ],
    where: { emiId: emiIds },
    group: ['emiId'],
    raw: true,
    transaction
  });

  return new Map(rows.map((row) => [Number(row.emiId), toPaise(row.total ?? '0')]));
}

/** Outstanding on an instalment, in paise, given what the ledger says is paid. */
function outstandingPaise(emi, collectedPaise) {
  const remaining = toPaise(emi.emiAmount) - (collectedPaise ?? 0n);
  return remaining > 0n ? remaining : 0n;
}

/*
 * The money rules below are deliberately pure. Keeping them free of database
 * access means they can be exercised directly, and leaves validateAllocations
 * responsible only for locking and for feeding them the current balances.
 */

/** Rejects duplicates and non-positive amounts. Returns the total in paise. */
function assertAllocationShape(allocations) {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw ApiError.badRequest('At least one allocation is required');
  }

  if (allocations.length > MAX_ALLOCATIONS_PER_COLLECTION) {
    throw ApiError.badRequest(`A collection cannot allocate to more than ${MAX_ALLOCATIONS_PER_COLLECTION} instalments`);
  }

  const emiIds = allocations.map((allocation) => Number(allocation.emiId));
  if (new Set(emiIds).size !== emiIds.length) {
    throw ApiError.badRequest('Each instalment may appear only once in the allocation list');
  }

  let total = 0n;
  for (const allocation of allocations) {
    const amountPaise = toPaise(allocation.amount);
    if (amountPaise <= 0n) {
      throw ApiError.badRequest('Every allocation must be greater than zero');
    }
    total += amountPaise;
  }

  return total;
}

/**
 * A posted collection accounts for every rupee: the allocations must total the
 * collection amount exactly, neither over nor under.
 */
function assertAllocationTotal(allocatedTotalPaise, collectionAmount) {
  const amountPaise = toPaise(collectionAmount);

  if (allocatedTotalPaise > amountPaise) {
    throw ApiError.badRequest(
      `Allocations total ${fromPaise(allocatedTotalPaise)}, which is more than the collection amount ${collectionAmount}`
    );
  }

  if (allocatedTotalPaise < amountPaise) {
    throw ApiError.badRequest(
      `Allocations total ${fromPaise(allocatedTotalPaise)}, leaving ${fromPaise(amountPaise - allocatedTotalPaise)} unallocated. Allocate the full collection amount.`
    );
  }

  return amountPaise;
}

/**
 * No instalment may take more than it still owes. Excess is refused outright
 * rather than spilling into the next instalment — automatic spillover would be
 * an allocation strategy, and Phase 7 stays explicit.
 */
function assertWithinOutstanding({ emiNumber, requestedPaise, remainingPaise }) {
  if (remainingPaise === 0n) {
    throw ApiError.conflict(`Instalment ${emiNumber} is already fully paid`);
  }

  if (requestedPaise > remainingPaise) {
    throw ApiError.conflict(
      `Allocation ${fromPaise(requestedPaise)} exceeds the ${fromPaise(remainingPaise)} outstanding on instalment ${emiNumber}`
    );
  }
}

/**
 * The date an instalment became fully paid, given its valid allocations in
 * chronological order. Returns null while the instalment is still short, so a
 * partial payment never stamps a date and a reversal correctly clears it.
 */
function resolvePaymentDate(orderedAllocations, emiAmount) {
  const due = toPaise(emiAmount);
  let running = 0n;

  for (const allocation of orderedAllocations) {
    running += toPaise(allocation.allocatedAmount);
    if (running >= due) {
      return allocation.collectionDate;
    }
  }

  return null;
}

/**
 * The date an instalment became fully paid.
 *
 * Walks its POSTED allocations oldest-first and returns the collection date at
 * which the cumulative total first covers the instalment. Still short of the
 * full amount means NULL, so a partial payment never stamps a payment date, and
 * a reversal correctly clears or moves it.
 */
async function derivePaymentDate(emi, transaction) {
  const allocations = await CollectionAllocation.findAll({
    where: { emiId: emi.id },
    include: [
      {
        association: 'Collection',
        attributes: ['id', 'collectionDate', 'status'],
        where: { status: COLLECTION_STATUS.POSTED },
        required: true
      }
    ],
    order: [
      [{ model: Collection, as: 'Collection' }, 'collectionDate', 'ASC'],
      [{ model: Collection, as: 'Collection' }, 'id', 'ASC']
    ],
    transaction
  });

  return resolvePaymentDate(
    allocations.map((allocation) => ({
      allocatedAmount: allocation.allocatedAmount,
      collectionDate: allocation.Collection.collectionDate
    })),
    emi.emiAmount
  );
}

/**
 * Rewrites the derived columns on the given instalments from the ledger.
 *
 * Status and DPD come from the Phase 6 model methods — that logic is reused, not
 * restated, so PARTIAL/OVERDUE precedence and the DPD rules stay in one place.
 */
async function recalculateEmis(emiIds, transaction, asOf = today()) {
  const ids = [...new Set(emiIds.map(Number))].sort((a, b) => a - b);
  if (ids.length === 0) return [];

  const emis = await EmiSchedule.findAll({ where: { id: ids }, order: [['id', 'ASC']], transaction });
  const collected = await calculateCollectedByEmi(ids, transaction);

  const updated = [];

  for (const emi of emis) {
    const collectedPaise = collected.get(emi.id) ?? 0n;

    // Set the collected total first: computeStatus/computeDpd read it.
    emi.set('amountCollected', fromPaise(collectedPaise));

    const paymentDate = await derivePaymentDate(emi, transaction);
    const status = emi.computeStatus(asOf);
    const dpd = emi.computeDpd(asOf);

    await emi.update({ amountCollected: fromPaise(collectedPaise), paymentDate, status, dpd }, { transaction });

    updated.push(emi);
  }

  return updated;
}

/**
 * Checks a set of requested allocations against the collection amount and each
 * instalment's outstanding balance, using the locked rows.
 *
 * Rejects, per the Phase 7 rules:
 *   - allocations that do not sum exactly to the collection amount
 *   - more than one allocation to the same instalment
 *   - any allocation over an instalment's outstanding balance (no automatic
 *     spillover to the next instalment)
 *   - instalments belonging to a different loan
 *
 * `collectionAmount` is the INSTALMENT portion of the payment — the total
 * received minus any bounce component — because bounce is not allocated to an
 * instalment. For every collection posted before bounce existed, and for every
 * collection posted without one, that portion is the whole amount and this
 * function behaves exactly as it always has.
 */
async function validateAllocations({ allocations, collectionAmount, loanId, transaction }) {
  /*
   * A payment that was entirely bounce has no instalment portion, so there is
   * nothing to allocate and no allocation row to write. This is the ONLY case
   * in which a collection may carry none — the "allocate every rupee" rule is
   * unchanged, it is simply satisfied by zero rupees of instalment.
   */
  if (toPaise(collectionAmount) === 0n) {
    if (Array.isArray(allocations) && allocations.length > 0) {
      throw ApiError.badRequest(
        'This payment is entirely a bounce collection, so it cannot be allocated to an instalment'
      );
    }
    return { planned: [], emiIds: [] };
  }

  // Shape and totals are checked before any lock is taken.
  const allocatedTotal = assertAllocationShape(allocations);
  assertAllocationTotal(allocatedTotal, collectionAmount);

  const emiIds = allocations.map((allocation) => Number(allocation.emiId));
  const { byId, orderedIds } = await lockEmis(emiIds, transaction);

  const foreign = orderedIds.filter((id) => Number(byId.get(id).loanId) !== Number(loanId));
  if (foreign.length > 0) {
    throw ApiError.badRequest(`Instalment(s) ${foreign.join(', ')} do not belong to this loan`);
  }

  // Balances are read only after the rows are locked, so what is validated here
  // is what will still be true at commit.
  const collected = await calculateCollectedByEmi(orderedIds, transaction);

  const planned = allocations.map((allocation) => {
    const emi = byId.get(Number(allocation.emiId));
    const requestedPaise = toPaise(allocation.amount);

    assertWithinOutstanding({
      emiNumber: emi.emiNumber,
      requestedPaise,
      remainingPaise: outstandingPaise(emi, collected.get(emi.id))
    });

    return { emiId: emi.id, allocatedAmount: fromPaise(requestedPaise) };
  });

  return { planned, emiIds: orderedIds };
}

/**
 * Suggests an oldest-first split of an amount across outstanding instalments.
 *
 * Posting stays strictly explicit — nothing calls this during a manual post —
 * but the bulk importer uses it to derive the split a spreadsheet row implies,
 * so an imported collection lands exactly where the same collection entered by
 * hand oldest-first would.
 *
 * `extraCollected` lets a caller add amounts that are not in the ledger yet:
 * the import preview walks a whole workbook without writing anything, so each
 * row must see what the rows above it would already have consumed. It is a
 * Map of emiId to paise, and it is never used when actually posting — by then
 * the ledger itself holds the earlier rows.
 */
async function planFifoAllocation({ loanId, amount, transaction, extraCollected = null }) {
  const emis = await EmiSchedule.findAll({
    where: { loanId },
    order: [['emiNumber', 'ASC']],
    transaction
  });

  const collected = await calculateCollectedByEmi(
    emis.map((emi) => emi.id),
    transaction
  );

  if (extraCollected) {
    extraCollected.forEach((paise, emiId) => {
      collected.set(Number(emiId), (collected.get(Number(emiId)) ?? 0n) + paise);
    });
  }

  let remaining = toPaise(amount);
  const plan = [];

  for (const emi of emis) {
    if (remaining <= 0n) break;

    const due = outstandingPaise(emi, collected.get(emi.id));
    if (due === 0n) continue;

    const take = due < remaining ? due : remaining;
    plan.push({ emiId: emi.id, emiNumber: emi.emiNumber, amount: fromPaise(take) });
    remaining -= take;
  }

  return { plan, unallocated: fromPaise(remaining) };
}

/**
 * Splits one allocated amount into principal and interest.
 *
 * NOT a calculation of interest — no rate, term or method is involved. The
 * instalment's principal and interest were fixed when the schedule was
 * generated; this only apportions what was actually paid against the two
 * figures already stored on that row, pro rata:
 *
 *   principal = round(allocated x emi.principal / emi.emiAmount)
 *   interest  = allocated - principal
 *
 * Interest takes the remainder so the two ALWAYS sum to the allocated amount
 * exactly, at every level of aggregation, with no rounding drift. Pro rata is
 * deliberate over interest-first: the split of one payment then never depends on
 * the order of other payments against the same instalment, so reversing one
 * collection cannot retroactively change another collection's reported split.
 *
 * All arithmetic is integer paise.
 */
function splitAllocation({ allocatedPaise, principalPaise, emiAmountPaise }) {
  if (emiAmountPaise <= 0n) {
    // A zero-value instalment cannot be apportioned; nothing is interest.
    return { principalPaise: allocatedPaise, interestPaise: 0n };
  }

  const principalShare = divideRoundHalfUp(allocatedPaise * principalPaise, emiAmountPaise);
  return { principalPaise: principalShare, interestPaise: allocatedPaise - principalShare };
}

/**
 * The principal / interest breakdown of a set of collections, read straight
 * from the allocation ledger.
 *
 * One query. Every value comes from a stored column: `allocated_amount` from
 * the ledger and `principal` / `emi_amount` from the instalment the payment
 * landed on.
 *
 * BOUNCE IS NOT HERE, deliberately. It used to be reported from this function
 * as a memo — the `bounce_charge` recorded on whichever instalments a payment
 * happened to touch — which counted a charge nobody had paid. Bounce COLLECTION
 * is money, it lives on `collections.bounce_amount`, it is never allocated to
 * an instalment, and it is summed by `bounceCollected` below. An instalment's
 * `bounce_charge` is the charge assessed and says nothing about what was
 * collected, so nothing in this file reads it any more.
 */
async function allocationBreakdown(collectionWhere) {
  const rows = await CollectionAllocation.findAll({
    attributes: ['collectionId', 'emiId', 'allocatedAmount'],
    include: [
      { association: 'Collection', attributes: [], where: collectionWhere, required: true },
      { association: 'Emi', attributes: ['principal', 'emiAmount'], required: true }
    ],
    raw: true,
    nest: true
  });

  const byCollection = new Map();

  let principalTotal = 0n;
  let interestTotal = 0n;

  for (const row of rows) {
    const allocatedPaise = toPaise(String(row.allocatedAmount));
    const { principalPaise, interestPaise } = splitAllocation({
      allocatedPaise,
      principalPaise: toPaise(String(row.Emi.principal)),
      emiAmountPaise: toPaise(String(row.Emi.emiAmount))
    });

    const entry = byCollection.get(row.collectionId) ?? { principal: 0n, interest: 0n };
    entry.principal += principalPaise;
    entry.interest += interestPaise;
    byCollection.set(row.collectionId, entry);

    principalTotal += principalPaise;
    interestTotal += interestPaise;
  }

  return {
    byCollection: new Map(
      [...byCollection.entries()].map(([collectionId, entry]) => [
        collectionId,
        {
          collectedPrincipal: fromPaise(entry.principal),
          collectedInterest: fromPaise(entry.interest),
          // Principal + interest, i.e. this collection's allocated total. The
          // EMI half of the payment; the bounce half sits beside it.
          emiCollected: fromPaise(entry.principal + entry.interest)
        }
      ])
    ),
    totals: {
      collectedPrincipal: fromPaise(principalTotal),
      collectedInterest: fromPaise(interestTotal),
      emiCollected: fromPaise(principalTotal + interestTotal)
    }
  };
}

/**
 * BOUNCE COLLECTION for a set of collections: money actually received against a
 * bounce charge.
 *
 * Summed from `collections.bounce_amount` — a value that only ever becomes
 * non-zero because someone posted a collection carrying a bounce component. It
 * is NOT derived from `emi_schedules.bounce_charge`, so an instalment carrying
 * an unpaid 500.00 charge contributes 0.00 here, and starts contributing 500.00
 * only once a collection is posted for it.
 *
 * The caller supplies the filter, which is what makes this obey the collection
 * date, the POSTED/REVERSED rule and the route scope exactly as every other
 * collection figure does — a reversed collection stops counting here for the
 * same reason it stops counting anywhere else.
 *
 * `count` is the number of collections that carried any bounce at all, which is
 * what "12 collections" on the dashboard card means.
 */
async function bounceCollected(collectionWhere) {
  const [row] = await Collection.findAll({
    attributes: [
      [fn('COALESCE', fn('SUM', col('bounce_amount')), 0), 'total'],
      [fn('COALESCE', fn('SUM', literal('CASE WHEN bounce_amount > 0 THEN 1 ELSE 0 END')), 0), 'count']
    ],
    where: collectionWhere,
    raw: true
  });

  return {
    bounceCollection: fromPaise(toPaise(String(row?.total ?? '0'))),
    bounceCollectionCount: Number(row?.count ?? 0)
  };
}

module.exports = {
  splitAllocation,
  allocationBreakdown,
  bounceCollected,
  lockEmis,
  calculateCollectedByEmi,
  outstandingPaise,
  assertAllocationShape,
  assertAllocationTotal,
  assertWithinOutstanding,
  resolvePaymentDate,
  derivePaymentDate,
  recalculateEmis,
  validateAllocations,
  planFifoAllocation
};
