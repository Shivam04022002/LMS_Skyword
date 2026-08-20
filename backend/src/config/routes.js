'use strict';

/**
 * Field collection route constants.
 *
 * Route code format: RT + two-digit year + "-" + a zero-padded six-digit
 * sequence, e.g. RT26-000001 — the same shape as loan and collection numbers.
 * Backend generated, unique and immutable.
 */
const ROUTE_CODE_PREFIX = 'RT';
const ROUTE_CODE_PADDING = 6;
const ROUTE_CODE_SEPARATOR = '-';

const formatRouteYear = (year) => String(year).slice(-2);

/** RT26-000001 — never built in React, never random or timestamp-derived. */
function formatRouteCode(year, sequenceNumber) {
  const padded = String(sequenceNumber).padStart(ROUTE_CODE_PADDING, '0');
  return `${ROUTE_CODE_PREFIX}${formatRouteYear(year)}${ROUTE_CODE_SEPARATOR}${padded}`;
}

const ROUTE_CODE_PATTERN = new RegExp(
  `^${ROUTE_CODE_PREFIX}\\d{2}${ROUTE_CODE_SEPARATOR}\\d{${ROUTE_CODE_PADDING}}$`
);

const isValidRouteCode = (value) => typeof value === 'string' && ROUTE_CODE_PATTERN.test(value);

/** Routes are deactivated, never deleted — history stays readable. */
const ROUTE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE'
});

const ROUTE_STATUS_VALUES = Object.values(ROUTE_STATUS);

/**
 * Assignment rows (collector→route and loan→route) are never deleted either.
 * Unassigning sets REMOVED and stamps `unassigned_at`, so the full assignment
 * history remains recoverable.
 */
const ASSIGNMENT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  REMOVED: 'REMOVED'
});

const ASSIGNMENT_STATUS_VALUES = Object.values(ASSIGNMENT_STATUS);

/**
 * Demand buckets, derived from an instalment's due date and outstanding amount
 * relative to the requested business date.
 */
const DEMAND_BUCKET = Object.freeze({
  OVERDUE: 'OVERDUE',
  DUE_TODAY: 'DUE_TODAY',
  UPCOMING: 'UPCOMING'
});

const DEMAND_BUCKET_VALUES = Object.values(DEMAND_BUCKET);

module.exports = {
  ROUTE_CODE_PREFIX,
  ROUTE_CODE_PADDING,
  ROUTE_CODE_SEPARATOR,
  ROUTE_CODE_PATTERN,
  formatRouteYear,
  formatRouteCode,
  isValidRouteCode,
  ROUTE_STATUS,
  ROUTE_STATUS_VALUES,
  ASSIGNMENT_STATUS,
  ASSIGNMENT_STATUS_VALUES,
  DEMAND_BUCKET,
  DEMAND_BUCKET_VALUES
};
