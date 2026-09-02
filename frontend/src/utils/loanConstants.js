/** Mirrors backend/src/config/loans.js. */
export const LOAN_TYPES = ['DAILY', 'WEEKLY', 'BI_WEEKLY', 'MONTHLY'];

export const LOAN_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'];

/**
 * What a loan's ROI percentage means. New loans are quoted per month; loans
 * created before that change carry ANNUAL and keep their original pricing.
 */
export const ROI_BASIS = Object.freeze({
  ANNUAL: 'ANNUAL',
  MONTHLY: 'MONTHLY'
});

export const ROI_BASIS_SUFFIX = Object.freeze({
  ANNUAL: 'per annum',
  MONTHLY: 'per month'
});

/** "1.5% per month" — falls back to the current basis when none is recorded. */
export const formatRoi = (roi, basis = ROI_BASIS.MONTHLY) =>
  roi === null || roi === undefined || roi === '' ? null : `${Number(roi)}% ${ROI_BASIS_SUFFIX[basis] ?? ROI_BASIS_SUFFIX.MONTHLY}`;

/** How interest is charged. Stored on the loan; the backend does the maths. */
export const INTEREST_METHODS = ['FLAT', 'REDUCING'];

export const INTEREST_METHOD_LABELS = Object.freeze({
  FLAT: 'Flat',
  REDUCING: 'Reducing'
});

export const INTEREST_METHOD_DESCRIPTIONS = Object.freeze({
  FLAT: 'Interest is charged on the original principal for the whole term, so every instalment carries the same interest.',
  REDUCING:
    'Interest is charged on the principal still outstanding, so it falls with every instalment while the instalment amount stays level.'
});

/**
 * What the tenure number counts. PERIODS is the original meaning (days for a
 * daily loan); MONTHS writes the loan as a contract of N calendar months.
 */
export const TENURE_UNITS = ['PERIODS', 'MONTHS'];

/** Loan types that can be written as a contract of months. Mirrors the backend. */
export const MONTH_TENURE_LOAN_TYPES = ['DAILY', 'WEEKLY', 'BI_WEEKLY', 'MONTHLY'];

export const supportsMonthTenure = (loanType) => MONTH_TENURE_LOAN_TYPES.includes(loanType);

/**
 * Whether the form offers a choice of tenure unit.
 *
 * A MONTHLY loan is excluded: its periods ARE months, so both readings are the
 * same statement and a selector would offer "months" twice.
 */
export const showsTenureUnitChoice = (loanType) => supportsMonthTenure(loanType) && loanType !== 'MONTHLY';

/**
 * The unit a loan type is written in by default.
 *
 * Weekly and bi-weekly loans are agreed as a contract of months and collected
 * weekly or fortnightly inside it, so months is what the form opens on. Daily
 * loans keep their original day-based default, and a monthly loan's tenure is
 * months either way.
 */
export const DEFAULT_TENURE_UNIT_BY_TYPE = Object.freeze({
  DAILY: 'PERIODS',
  WEEKLY: 'MONTHS',
  BI_WEEKLY: 'MONTHS',
  MONTHLY: 'PERIODS'
});

export const defaultTenureUnit = (loanType) => DEFAULT_TENURE_UNIT_BY_TYPE[loanType] ?? 'PERIODS';

/** Unit word for the tenure input: "days", "weeks", "fortnights", "months". */
export const tenureUnitLabel = (loanType, tenureUnit) =>
  tenureUnit === 'MONTHS' ? 'months' : PERIOD_LABELS[loanType] ?? 'periods';

/**
 * A loan that collects in days — daily, weekly or bi-weekly — and is written in
 * months states how many collections repay it. A monthly loan has one
 * collection per contractual month, so it has no such field. Mirrors the
 * backend rule; the backend re-checks it regardless.
 */
export const COLLECTION_STEP_DAYS = Object.freeze({ DAILY: 1, WEEKLY: 7, BI_WEEKLY: 14 });

export const usesCollectionCount = (loanType, tenureUnit) =>
  Boolean(COLLECTION_STEP_DAYS[loanType]) && tenureUnit === 'MONTHS';

/** What the collection-count field is called for each loan type. */
export const COLLECTION_COUNT_LABELS = Object.freeze({
  DAILY: 'Number of days',
  WEEKLY: 'Number of weeks',
  BI_WEEKLY: 'Number of bi-weekly collections'
});

export const collectionCountLabel = (loanType) => COLLECTION_COUNT_LABELS[loanType] ?? 'Number of collections';

/** The help line under that field, in the loan type's own words. */
export const COLLECTION_COUNT_HINTS = Object.freeze({
  DAILY: 'How many daily collections repay the loan — not calendar days.',
  WEEKLY: 'How many weekly collections repay the loan. Each is 7 days after the last.',
  BI_WEEKLY: 'How many bi-weekly collections repay the loan. Each is 14 days after the last.'
});

export const collectionCountHint = (loanType) => COLLECTION_COUNT_HINTS[loanType] ?? '';

/** Weekly non-collection day. Only daily loans can have one. */
export const WEEKLY_OFF_VALUES = ['NONE', 'SUNDAY'];

export const WEEKLY_OFF_LABELS = Object.freeze({
  NONE: 'None — collect every day',
  SUNDAY: 'Sunday — no collection on Sundays'
});

/** Loan types for which a weekly off is offered. Mirrors the backend rule. */
export const WEEKLY_OFF_LOAN_TYPES = ['DAILY'];

export const supportsWeeklyOff = (loanType) => WEEKLY_OFF_LOAN_TYPES.includes(loanType);

/** What a tenure period means for each loan type. */
export const PERIOD_LABELS = Object.freeze({
  DAILY: 'days',
  WEEKLY: 'weeks',
  BI_WEEKLY: 'fortnights',
  MONTHLY: 'months'
});

/** Statuses in which the loan can still be edited. */
export const EDITABLE_STATUSES = ['DRAFT'];

export const READ_ONLY_STATUSES = ['CLOSED', 'CANCELLED'];

/** Transitions offered by the UI; the backend re-validates every one. */
export const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: []
});

/**
 * Formats a DECIMAL string from the API without floating-point drift.
 *
 * Grouping is the INDIAN system: the last three digits, then twos —
 * 22,07,381.49, not the international 2,207,381.49.
 *
 * Deliberately still string-based rather than Intl.NumberFormat('en-IN'):
 * that would require Number(value), reintroducing exactly the floating-point
 * conversion this function exists to avoid. The value arrives as a decimal
 * string from the API and leaves as one, with only separators inserted.
 */
export function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return '—';
  const [whole, fraction = '00'] = String(value).split('.');

  // The sign is held aside so it cannot be mistaken for a digit group.
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;

  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;

  return `₹${negative ? '-' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export const titleCase = (value) =>
  typeof value === 'string' ? value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '';
