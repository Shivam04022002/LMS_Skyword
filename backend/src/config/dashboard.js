'use strict';

const { today, addDays } = require('../utils/dates');

/**
 * Dashboard constants.
 *
 * The dashboard adds no tables and no financial rules — it is a consumer of the
 * Phase 5–9 services. What lives here is presentation-level: period shorthands
 * and the alert vocabulary.
 */

/** Named periods the UI offers; all resolve to an explicit [from, to] pair. */
const PERIODS = Object.freeze({
  TODAY: 'TODAY',
  YESTERDAY: 'YESTERDAY',
  THIS_MONTH: 'THIS_MONTH',
  CUSTOM: 'CUSTOM'
});

const PERIOD_VALUES = Object.values(PERIODS);

/**
 * Resolves a period into concrete dates.
 *
 * `businessDate` is the "as of" point for demand and DPD; `from`/`to` bound the
 * collection window. They are separate on purpose: "collections this month,
 * demand as of today" is the normal operational question.
 */
function resolvePeriod({ period, date, dateFrom, dateTo } = {}, clock = new Date()) {
  const businessDate = date || today(clock);

  switch (period) {
    case PERIODS.YESTERDAY: {
      const yesterday = addDays(businessDate, -1);
      return { period: PERIODS.YESTERDAY, businessDate: yesterday, from: yesterday, to: yesterday };
    }
    case PERIODS.THIS_MONTH: {
      const monthStart = `${businessDate.slice(0, 7)}-01`;
      return { period: PERIODS.THIS_MONTH, businessDate, from: monthStart, to: businessDate };
    }
    case PERIODS.CUSTOM:
      return {
        period: PERIODS.CUSTOM,
        businessDate,
        from: dateFrom || businessDate,
        to: dateTo || businessDate
      };
    case PERIODS.TODAY:
    default:
      return { period: PERIODS.TODAY, businessDate, from: businessDate, to: businessDate };
  }
}

/**
 * Alert types. Every one is a plain fact read from existing data — there are
 * deliberately no invented risk scores or weightings.
 */
const ALERT_TYPES = Object.freeze({
  OVERDUE_EMIS: 'OVERDUE_EMIS',
  PARTIAL_EMIS: 'PARTIAL_EMIS',
  ROUTE_OUTSTANDING: 'ROUTE_OUTSTANDING',
  UNROUTED_LOANS: 'UNROUTED_LOANS',
  ROUTE_WITHOUT_COLLECTOR: 'ROUTE_WITHOUT_COLLECTOR',
  REVERSED_COLLECTIONS: 'REVERSED_COLLECTIONS'
});

const ALERT_SEVERITY = Object.freeze({ INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' });

/** Route performance rows returned to the dashboard; the UI pages beyond this. */
const MAX_PERFORMANCE_ROWS = 100;

module.exports = { PERIODS, PERIOD_VALUES, resolvePeriod, ALERT_TYPES, ALERT_SEVERITY, MAX_PERFORMANCE_ROWS };
