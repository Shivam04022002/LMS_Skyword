'use strict';

/**
 * Loan module constants.
 *
 * Loan number format: LN + two-digit year + "-" + a zero-padded six-digit
 * sequence, e.g. LN26-000001. The year is the year the loan is created (the
 * number is an issuance identifier), and the sequence restarts each year.
 */
const LOAN_NUMBER_PREFIX = 'LN';
const LOAN_NUMBER_PADDING = 6;
const LOAN_NUMBER_YEAR_FORMAT = 'YY';
const LOAN_NUMBER_SEPARATOR = '-';

/** 2026 -> "26" */
function formatLoanYear(year) {
  return String(year).slice(-2);
}

/** LN26-000001 — never built in React, never from a timestamp or random value. */
function formatLoanNumber(year, sequenceNumber) {
  const paddedSequence = String(sequenceNumber).padStart(LOAN_NUMBER_PADDING, '0');
  return `${LOAN_NUMBER_PREFIX}${formatLoanYear(year)}${LOAN_NUMBER_SEPARATOR}${paddedSequence}`;
}

const LOAN_NUMBER_PATTERN = new RegExp(
  `^${LOAN_NUMBER_PREFIX}\\d{2}${LOAN_NUMBER_SEPARATOR}\\d{${LOAN_NUMBER_PADDING}}$`
);

const isValidLoanNumber = (value) => typeof value === 'string' && LOAN_NUMBER_PATTERN.test(value);

/**
 * Repayment frequency. `tenure` counts periods of this type — a MONTHLY loan
 * with tenure 12 runs twelve monthly periods, a DAILY loan with tenure 12 runs
 * twelve daily periods. Tenure is never assumed to mean months.
 */
const LOAN_TYPES = Object.freeze({
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  BI_WEEKLY: 'BI_WEEKLY',
  MONTHLY: 'MONTHLY'
});

const LOAN_TYPE_VALUES = Object.values(LOAN_TYPES);

/** Periods per year, used to convert tenure into a fraction of a year. */
const PERIODS_PER_YEAR = Object.freeze({
  [LOAN_TYPES.DAILY]: 365,
  [LOAN_TYPES.WEEKLY]: 52,
  [LOAN_TYPES.BI_WEEKLY]: 26,
  [LOAN_TYPES.MONTHLY]: 12
});

/**
 * Days between collections, for the loan types that step in whole days. A
 * MONTHLY loan is absent on purpose: it steps in calendar months, which are not
 * a fixed number of days.
 */
const COLLECTION_STEP_DAYS = Object.freeze({
  [LOAN_TYPES.DAILY]: 1,
  [LOAN_TYPES.WEEKLY]: 7,
  [LOAN_TYPES.BI_WEEKLY]: 14
});

/**
 * How interest is charged. Stored on every loan, so a later change of the
 * default can never re-price a loan that already exists.
 *
 *   FLAT     — interest on the original principal for the whole term.
 *   REDUCING — interest on the outstanding principal of each instalment, which
 *              falls as principal is repaid.
 */
const INTEREST_METHODS = Object.freeze({
  FLAT: 'FLAT',
  REDUCING: 'REDUCING'
});

const INTEREST_METHOD_VALUES = Object.values(INTEREST_METHODS);

/**
 * Weekly non-collection day. Only DAILY loans can have one: a weekly or monthly
 * instalment does not fall on a "day of the week" in any meaningful sense.
 */
const WEEKLY_OFF = Object.freeze({
  NONE: 'NONE',
  SUNDAY: 'SUNDAY'
});

const WEEKLY_OFF_VALUES = Object.values(WEEKLY_OFF);

/** Loan types for which a weekly off other than NONE is meaningful. */
const WEEKLY_OFF_LOAN_TYPES = Object.freeze([LOAN_TYPES.DAILY]);

/** Guards the one invalid combination: a weekly off on a non-daily loan. */
function isWeeklyOffAllowed(loanType, weeklyOff) {
  if (!weeklyOff || weeklyOff === WEEKLY_OFF.NONE) return true;
  return WEEKLY_OFF_LOAN_TYPES.includes(loanType);
}

/**
 * What `tenure` counts.
 *
 *   PERIODS — periods of the loan type: days for DAILY, weeks for WEEKLY,
 *             months for MONTHLY. This is the original meaning and stays the
 *             default, so every loan created before this change is unaffected.
 *   MONTHS  — calendar months of contractual term, whatever the instalment
 *             frequency. A DAILY loan of 6 MONTHS runs from its start date to
 *             the same day six months later and collects daily inside that
 *             window.
 *
 * MONTHS is only meaningful where a month-based contract makes sense: a DAILY
 * loan (the case this exists for) and a MONTHLY loan (where the two readings
 * are identical anyway).
 */
const TENURE_UNITS = Object.freeze({
  PERIODS: 'PERIODS',
  MONTHS: 'MONTHS'
});

const TENURE_UNIT_VALUES = Object.values(TENURE_UNITS);

/** Existing behaviour is the default: tenure counts periods of the loan type. */
const DEFAULT_TENURE_UNIT = TENURE_UNITS.PERIODS;

const MONTH_TENURE_LOAN_TYPES = Object.freeze([
  LOAN_TYPES.DAILY,
  LOAN_TYPES.WEEKLY,
  LOAN_TYPES.BI_WEEKLY,
  LOAN_TYPES.MONTHLY
]);

/** Every loan type can be written as a contract of months. */
function isTenureUnitAllowed(loanType, tenureUnit) {
  if (!tenureUnit || tenureUnit === TENURE_UNITS.PERIODS) return true;
  return MONTH_TENURE_LOAN_TYPES.includes(loanType);
}

const LOAN_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED'
});

const LOAN_STATUS_VALUES = Object.values(LOAN_STATUS);

/** Financial terms are fixed once a loan leaves DRAFT. */
const FINANCIAL_FIELDS = Object.freeze([
  'loanAmount',
  'roi',
  'tenure',
  'loanType',
  'startDate',
  'interestMethod',
  'weeklyOff',
  'tenureUnit'
]);

/** Statuses in which no field may be edited at all. */
const READ_ONLY_STATUSES = Object.freeze([LOAN_STATUS.CLOSED, LOAN_STATUS.CANCELLED]);

/**
 * What the stored `roi` percentage means.
 *
 *   MONTHLY — the rate the operator enters is per month (the current rule).
 *   ANNUAL  — the rate is per year (every loan created before this change).
 *
 * The basis is stored on each loan rather than assumed globally, so loans
 * priced under the old meaning keep it forever and are never re-priced by a
 * change of system default. `MONTHS_PER_YEAR` is the only conversion constant:
 * a monthly rate is normalised to its annual equivalent, after which the
 * existing per-period conversion applies unchanged.
 */
const ROI_BASIS = Object.freeze({
  ANNUAL: 'ANNUAL',
  MONTHLY: 'MONTHLY'
});

const ROI_BASIS_VALUES = Object.values(ROI_BASIS);

/** New loans are priced on a monthly rate. */
const DEFAULT_ROI_BASIS = ROI_BASIS.MONTHLY;

const MONTHS_PER_YEAR = 12;

/** ROI is stored as a percentage: 1.50 means 1.50% for one period of its basis. */
const ROI_DECIMALS = 4;
const ROI_MIN = 0;
const ROI_MAX = 100;

const LOAN_AMOUNT_MIN = 1;
const LOAN_AMOUNT_MAX = 999999999.99;

const TENURE_MIN = 1;
const TENURE_MAX = 3650;

/**
 * `collectionCount` is how many instalments collect a contract — days for a
 * daily loan, weeks for a weekly one, fortnights for a bi-weekly one. It is a
 * COUNT of collections, never a span of calendar days.
 *
 * It applies wherever the contract length and the number of collections are two
 * different numbers: a tenure written in months, on a loan type that steps in
 * days. A MONTHLY loan has one collection per contractual month, so it has no
 * such number.
 */
const COLLECTION_COUNT_MIN = 1;
const COLLECTION_COUNT_MAX = TENURE_MAX;

function usesCollectionCount(loanType, tenureUnit) {
  return Boolean(COLLECTION_STEP_DAYS[loanType]) && tenureUnit === TENURE_UNITS.MONTHS;
}

/** What one collection is called, for messages and labels. */
const COLLECTION_UNIT_LABELS = Object.freeze({
  [LOAN_TYPES.DAILY]: 'days',
  [LOAN_TYPES.WEEKLY]: 'weeks',
  [LOAN_TYPES.BI_WEEKLY]: 'bi-weekly collections'
});

const collectionUnitLabel = (loanType) => COLLECTION_UNIT_LABELS[loanType] ?? 'collections';

module.exports = {
  LOAN_NUMBER_PREFIX,
  LOAN_NUMBER_PADDING,
  LOAN_NUMBER_YEAR_FORMAT,
  LOAN_NUMBER_SEPARATOR,
  LOAN_NUMBER_PATTERN,
  formatLoanYear,
  formatLoanNumber,
  isValidLoanNumber,
  LOAN_TYPES,
  LOAN_TYPE_VALUES,
  PERIODS_PER_YEAR,
  TENURE_UNITS,
  TENURE_UNIT_VALUES,
  DEFAULT_TENURE_UNIT,
  MONTH_TENURE_LOAN_TYPES,
  isTenureUnitAllowed,
  ROI_BASIS,
  ROI_BASIS_VALUES,
  DEFAULT_ROI_BASIS,
  MONTHS_PER_YEAR,
  INTEREST_METHODS,
  INTEREST_METHOD_VALUES,
  WEEKLY_OFF,
  WEEKLY_OFF_VALUES,
  WEEKLY_OFF_LOAN_TYPES,
  isWeeklyOffAllowed,
  LOAN_STATUS,
  LOAN_STATUS_VALUES,
  FINANCIAL_FIELDS,
  READ_ONLY_STATUSES,
  ROI_DECIMALS,
  ROI_MIN,
  ROI_MAX,
  LOAN_AMOUNT_MIN,
  LOAN_AMOUNT_MAX,
  TENURE_MIN,
  TENURE_MAX,
  COLLECTION_COUNT_MIN,
  COLLECTION_COUNT_MAX,
  COLLECTION_STEP_DAYS,
  COLLECTION_UNIT_LABELS,
  collectionUnitLabel,
  usesCollectionCount,
  LOAN_SEQUENCE_TABLE: 'loan_sequences'
};
