'use strict';

/**
 * Collection module constants.
 *
 * Collection number format: COL + two-digit year + "-" + a zero-padded
 * six-digit sequence, e.g. COL26-000001 — the same shape as the loan number, so
 * the two read consistently. The year is the year of posting and the sequence
 * restarts annually.
 */
const { toPaise } = require('../utils/money');
const { TENURE_MAX } = require('./loans');

const COLLECTION_NUMBER_PREFIX = 'COL';
const COLLECTION_NUMBER_PADDING = 6;
const COLLECTION_NUMBER_SEPARATOR = '-';

/** 2026 -> "26" */
const formatCollectionYear = (year) => String(year).slice(-2);

/** COL26-000001 — never built in React, never random or timestamp-derived. */
function formatCollectionNumber(year, sequenceNumber) {
  const padded = String(sequenceNumber).padStart(COLLECTION_NUMBER_PADDING, '0');
  return `${COLLECTION_NUMBER_PREFIX}${formatCollectionYear(year)}${COLLECTION_NUMBER_SEPARATOR}${padded}`;
}

const COLLECTION_NUMBER_PATTERN = new RegExp(
  `^${COLLECTION_NUMBER_PREFIX}\\d{2}${COLLECTION_NUMBER_SEPARATOR}\\d{${COLLECTION_NUMBER_PADDING}}$`
);

const isValidCollectionNumber = (value) => typeof value === 'string' && COLLECTION_NUMBER_PATTERN.test(value);

/** Where the money landed. */
const LEDGER_TYPES = Object.freeze({
  CASH: 'CASH',
  BANK: 'BANK'
});

const LEDGER_TYPE_VALUES = Object.values(LEDGER_TYPES);

/** A bank transfer must carry a traceable reference; cash need not. */
const LEDGER_TYPES_REQUIRING_REFERENCE = Object.freeze([LEDGER_TYPES.BANK]);

/**
 * Posted money is never deleted. A mistake is reversed and, if appropriate,
 * replaced by a fresh collection — which keeps the full history.
 */
const COLLECTION_STATUS = Object.freeze({
  POSTED: 'POSTED',
  REVERSED: 'REVERSED'
});

const COLLECTION_STATUS_VALUES = Object.values(COLLECTION_STATUS);

/**
 * Allocation strategies. Only EXPLICIT is reachable in Phase 7 — FIFO exists as
 * a planning helper the UI can call, but nothing allocates automatically.
 */
const ALLOCATION_STRATEGIES = Object.freeze({
  EXPLICIT: 'EXPLICIT',
  FIFO: 'FIFO'
});

/**
 * How many instalments one collection may allocate to.
 *
 * There are two ceilings because there are two kinds of allocation list, and
 * only one of them is supplied by a caller.
 *
 * MAX_ALLOCATIONS_PER_COLLECTION is a REQUEST-SHAPE limit. It governs an
 * allocations array that arrived in a request body — the Post Collection screen
 * and the permanent import — where the length is chosen by the caller, each
 * entry costs a row lock and a snapshot rebuild, and a long array is therefore
 * something to bound before any of that work starts. Nothing about the database
 * requires 100: `collection_allocations` has no row-count constraint, and the
 * 1 MB body limit would itself admit far more. It is a deliberate product bound
 * on client input and is UNCHANGED.
 *
 * MAX_PLANNED_ALLOCATIONS_PER_COLLECTION governs a list the SERVER planned,
 * from a loan's own schedule, with no caller influence over its length — which
 * today means the oneBulk importer's FIFO plan. A plan cannot be longer than
 * the loan has instalments, so the honest ceiling is the most instalments a
 * loan can have, and that is not a number to invent: every path through
 * loanCalculationService bounds `emiCount` by TENURE_MAX, whether the tenure
 * is written in periods (at most TENURE_MAX of them) or in months (which then
 * REQUIRES a collectionCount, itself capped at COLLECTION_COUNT_MAX =
 * TENURE_MAX). So this is TENURE_MAX: high enough that no real schedule can
 * exceed it, and still a fixed bound rather than none at all.
 */
const MAX_ALLOCATIONS_PER_COLLECTION = 100;
const MAX_PLANNED_ALLOCATIONS_PER_COLLECTION = TENURE_MAX;

/**
 * BOUNCE COLLECTION — money actually received against a bounce charge.
 *
 * Stored on the collection as `bounceAmount`, inside its `amount`:
 *
 *     amount (total received) = allocations total (EMI) + bounceAmount
 *
 * It is NOT `emi_schedules.bounce_charge`. That column is the charge ASSESSED
 * on an instalment and says nothing about whether anyone paid it; this one only
 * ever moves when a collection is posted carrying a bounce component. An
 * instalment can carry a 500.00 bounce charge for a year and contribute 0.00 to
 * bounce collection the whole time.
 *
 * Never enters an allocation, so it can never become principal or interest, and
 * never reaches `emi_schedules.amount_collected` — EMI outstanding, DPD, status
 * and collection efficiency are all computed exactly as before.
 */
const DEFAULT_BOUNCE_AMOUNT = '0.00';

/**
 * The instalment portion of a collection, in paise: what the allocations must
 * total. Zero means the whole payment was bounce, so there is nothing to
 * allocate — the only case in which a collection carries no allocation row.
 */
function emiPortionPaise(amount, bounceAmount = DEFAULT_BOUNCE_AMOUNT) {
  return toPaise(amount) - toPaise(bounceAmount ?? DEFAULT_BOUNCE_AMOUNT);
}

module.exports = {
  COLLECTION_NUMBER_PREFIX,
  COLLECTION_NUMBER_PADDING,
  COLLECTION_NUMBER_SEPARATOR,
  COLLECTION_NUMBER_PATTERN,
  formatCollectionYear,
  formatCollectionNumber,
  isValidCollectionNumber,
  LEDGER_TYPES,
  LEDGER_TYPE_VALUES,
  LEDGER_TYPES_REQUIRING_REFERENCE,
  COLLECTION_STATUS,
  COLLECTION_STATUS_VALUES,
  ALLOCATION_STRATEGIES,
  MAX_ALLOCATIONS_PER_COLLECTION,
  MAX_PLANNED_ALLOCATIONS_PER_COLLECTION,
  DEFAULT_BOUNCE_AMOUNT,
  emiPortionPaise,
  COLLECTION_SEQUENCE_TABLE: 'collection_sequences'
};
