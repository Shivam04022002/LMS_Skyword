'use strict';

/**
 * Collection module constants.
 *
 * Collection number format: COL + two-digit year + "-" + a zero-padded
 * six-digit sequence, e.g. COL26-000001 — the same shape as the loan number, so
 * the two read consistently. The year is the year of posting and the sequence
 * restarts annually.
 */
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
  COLLECTION_SEQUENCE_TABLE: 'collection_sequences'
};
