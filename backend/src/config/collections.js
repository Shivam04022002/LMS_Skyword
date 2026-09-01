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

const MAX_ALLOCATIONS_PER_COLLECTION = 100;

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
  DEFAULT_BOUNCE_AMOUNT,
  emiPortionPaise,
  COLLECTION_SEQUENCE_TABLE: 'collection_sequences'
};
