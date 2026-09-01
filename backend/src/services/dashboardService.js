'use strict';

const { Op, fn, col } = require('sequelize');
const { sequelize, Loan, Route, RouteCollector } = require('../models');
const reportService = require('./reportService');
const demandService = require('./demandService');
const routeService = require('./routeService');
const { toPaise, fromPaise, divideRoundHalfUp } = require('../utils/money');
const { LOAN_STATUS } = require('../config/loans');
const { ASSIGNMENT_STATUS, ROUTE_STATUS } = require('../config/routes');
const { EMI_STATUS } = require('../config/emis');
const { resolvePeriod, ALERT_TYPES, ALERT_SEVERITY, MAX_PERFORMANCE_ROWS } = require('../config/dashboard');

/**
 * Operational dashboard.
 *
 * A CONSUMER of the existing financial architecture, never a second source of
 * truth: loan, collection and EMI figures come from the Phase 9 report service
 * summaries, demand comes from the Phase 8 demand service, and scope comes from
 * reportService.resolveScope. No financial rule is restated here.
 *
 * The one piece of SQL below sums two stored columns over a date filter for
 * per-route grouping. It derives no status and applies no money rule — and the
 * reconciliation test asserts its overall total equals the demand service to the
 * paise, so the two cannot drift apart unnoticed.
 */

/* ------------------------------------------------------------ definitions */

/**
 * COLLECTION EFFICIENCY — denominator stated explicitly, as required.
 *
 *   denominator (dueValue)   SUM(emi_amount) of instalments whose due date is on
 *                            or before the business date, excluding WAIVED.
 *                            Fully paid instalments ARE included — otherwise a
 *                            well-performing route would score artificially low,
 *                            because paid instalments drop out of demand.
 *   numerator  (collected)   SUM(amount_collected) on those same instalments —
 *                            the ledger-derived figure Phase 7 maintains, so
 *                            reversed collections are already excluded.
 *
 *   efficiency = collected / dueValue
 *
 * Future instalments are never in the denominator, so upcoming demand cannot
 * dilute current performance.
 */
const EFFICIENCY_DEFINITION =
  'collected / due, where due = EMI value of instalments falling due on or before the business date (excluding waived), and collected = amount posted against those same instalments (reversed collections excluded). Bounce collection is NOT included: the denominator is instalment value, and a bounce charge is not part of an instalment, so counting bounce in the numerator would report efficiency above what was actually collected against demand.';

/**
 * BOUNCE COLLECTION — stated as explicitly as the ratio above, because the
 * obvious wrong answer is right next to the right one.
 *
 * It is money ACTUALLY RECEIVED against bounce charges: the `bounce_amount`
 * component of POSTED collections dated in the window, read through the same
 * collection report the rest of this card comes from, so it obeys the same
 * date, route and collector filters and drops reversed collections for the same
 * reason every other collected figure does.
 *
 * It is NOT the sum of `emi_schedules.bounce_charge`, nor of the charges on
 * overdue instalments, nor of what is outstanding. An instalment carrying an
 * unpaid 500.00 charge adds 0.00 here; the day a collection is posted for it,
 * it adds 500.00 — on that collection's date, not the instalment's due date.
 *
 * It is inside `collections.postedAmount` (which is the total money received)
 * and outside `efficiency.collected` (which is instalment money only). It is
 * never added to either, so nothing is double counted:
 *
 *     postedAmount = emiCollection + bounceCollection
 */
const BOUNCE_COLLECTION_DEFINITION =
  'bounce actually collected — the bounce component of POSTED collections dated in the period (reversed collections excluded), never the bounce charges assessed or outstanding on instalments';

/** Percentage to one decimal, computed in integer paise. */
function efficiencyPercent(collectedPaise, duePaise) {
  if (duePaise <= 0n) return null;
  return Number(divideRoundHalfUp(collectedPaise * 1000n, duePaise)) / 10;
}

/* ------------------------------------------------------ per-route aggregate */

/**
 * One grouped query covering every route — not one query per route.
 *
 * Only SUMs of stored columns, split by a date comparison. Restricted to ACTIVE
 * loans, matching what demand considers collectable.
 */
async function routeAggregate({ businessDate, routeIds }) {
  const replacements = { businessDate };
  let routeFilter = '';

  if (routeIds !== null) {
    if (routeIds.length === 0) return [];
    // Parameterised — no user input is ever concatenated into the statement.
    routeFilter = 'AND lr.route_id IN (:routeIds)';
    replacements.routeIds = routeIds;
  }

  const rows = await sequelize.query(
    `SELECT
        lr.route_id                                          AS routeId,
        COUNT(DISTINCT e.loan_id)                            AS loanCount,
        COUNT(*)                                             AS dueEmiCount,
        COALESCE(SUM(e.emi_amount), 0)                       AS dueValue,
        COALESCE(SUM(e.amount_collected), 0)                 AS collectedOnDue,
        COALESCE(SUM(CASE WHEN e.emi_date < :businessDate
                          THEN e.emi_amount - e.amount_collected ELSE 0 END), 0) AS overdueAmount,
        COALESCE(SUM(CASE WHEN e.emi_date < :businessDate
                               AND e.amount_collected < e.emi_amount
                          THEN 1 ELSE 0 END), 0)             AS overdueCount,
        COALESCE(SUM(CASE WHEN e.emi_date = :businessDate
                          THEN e.emi_amount - e.amount_collected ELSE 0 END), 0) AS dueTodayAmount,
        COALESCE(SUM(CASE WHEN e.amount_collected > 0
                               AND e.amount_collected < e.emi_amount
                          THEN 1 ELSE 0 END), 0)             AS partialCount
     FROM emi_schedules e
     JOIN loans l       ON l.id = e.loan_id AND l.status = '${LOAN_STATUS.ACTIVE}'
     JOIN loan_routes lr ON lr.loan_id = e.loan_id AND lr.status = '${ASSIGNMENT_STATUS.ACTIVE}'
     WHERE e.emi_date <= :businessDate
       AND e.status <> '${EMI_STATUS.WAIVED}'
       ${routeFilter}
     GROUP BY lr.route_id`,
    { replacements, type: sequelize.QueryTypes.SELECT }
  );

  return rows;
}

/** Overall totals for the same definition, ignoring route assignment. */
async function overallDueAggregate({ businessDate, loanIds }) {
  const replacements = { businessDate };
  let loanFilter = '';

  if (loanIds !== null) {
    if (loanIds.length === 0) return { dueValue: '0', collectedOnDue: '0', overdueAmount: '0', overdueCount: 0, overdueLoanCount: 0, dueTodayAmount: '0', partialCount: 0, dueEmiCount: 0 };
    loanFilter = 'AND e.loan_id IN (:loanIds)';
    replacements.loanIds = loanIds;
  }

  const [row] = await sequelize.query(
    `SELECT
        COUNT(*)                                             AS dueEmiCount,
        COALESCE(SUM(e.emi_amount), 0)                       AS dueValue,
        COALESCE(SUM(e.amount_collected), 0)                 AS collectedOnDue,
        COALESCE(SUM(CASE WHEN e.emi_date < :businessDate
                          THEN e.emi_amount - e.amount_collected ELSE 0 END), 0) AS overdueAmount,
        COALESCE(SUM(CASE WHEN e.emi_date < :businessDate
                               AND e.amount_collected < e.emi_amount
                          THEN 1 ELSE 0 END), 0)             AS overdueCount,
        COUNT(DISTINCT CASE WHEN e.emi_date < :businessDate
                                 AND e.amount_collected < e.emi_amount
                            THEN e.loan_id END)              AS overdueLoanCount,
        COALESCE(SUM(CASE WHEN e.emi_date = :businessDate
                          THEN e.emi_amount - e.amount_collected ELSE 0 END), 0) AS dueTodayAmount,
        COALESCE(SUM(CASE WHEN e.amount_collected > 0
                               AND e.amount_collected < e.emi_amount
                          THEN 1 ELSE 0 END), 0)             AS partialCount
     FROM emi_schedules e
     JOIN loans l ON l.id = e.loan_id AND l.status = '${LOAN_STATUS.ACTIVE}'
     WHERE e.emi_date <= :businessDate
       AND e.status <> '${EMI_STATUS.WAIVED}'
       ${loanFilter}`,
    { replacements, type: sequelize.QueryTypes.SELECT }
  );

  return row;
}

/** Loan counts by status — counts only, no money. */
async function loanStatusCounts(loanIds) {
  const where = loanIds !== null ? { id: { [Op.in]: loanIds.length ? loanIds : [0] } } : {};
  const rows = await Loan.findAll({
    attributes: ['status', [fn('COUNT', col('id')), 'count']],
    where,
    group: ['status'],
    raw: true
  });
  return rows.reduce((accumulator, row) => {
    accumulator[row.status] = Number(row.count);
    return accumulator;
  }, {});
}

/* ------------------------------------------------------------- dashboard */

async function getDashboard(filters = {}, actor) {
  const period = resolvePeriod(filters);
  const { businessDate, from, to } = period;

  // Same scope resolver the reports use: a collector cannot widen it, and
  // asking for someone else's route or id is refused rather than emptied.
  const scope = await reportService.resolveScope(actor, filters);
  const loanIds = scope.routeIds === null ? null : await reportService.loanIdsForRoutes(scope.routeIds);

  const scopedFilters = { routeId: filters.routeId, collectorId: filters.collectorId };

  // Report-service summaries are the authority for loan / collection / EMI
  // money. `limit: 1` because only the summary block is wanted — the summaries
  // are computed over the whole filtered set, not the page.
  const [activeLoans, todayCollections, periodCollections, emiTotals, statusCounts, overallDue, demandToday] =
    await Promise.all([
      reportService.loanReport({ ...scopedFilters, status: LOAN_STATUS.ACTIVE, limit: 1 }, actor),
      reportService.collectionReport({ ...scopedFilters, dateFrom: businessDate, dateTo: businessDate, limit: 1 }, actor),
      reportService.collectionReport({ ...scopedFilters, dateFrom: from, dateTo: to, limit: 1 }, actor),
      reportService.emiReport({ ...scopedFilters, date: businessDate, limit: 1 }, actor),
      loanStatusCounts(loanIds),
      overallDueAggregate({ businessDate, loanIds }),
      demandService.getDemand({ date: businessDate, routeId: filters.routeId, collectorId: filters.collectorId, limit: 1 }, actor)
    ]);

  const newLoansInPeriod = await Loan.count({
    where: {
      ...(loanIds !== null ? { id: { [Op.in]: loanIds.length ? loanIds : [0] } } : {}),
      createdAt: { [Op.between]: [`${from} 00:00:00`, `${to} 23:59:59`] }
    }
  });

  const duePaise = toPaise(String(overallDue.dueValue ?? '0'));
  const collectedOnDuePaise = toPaise(String(overallDue.collectedOnDue ?? '0'));

  /* ---------------------------------------------------- route performance */

  const routeRows = await routeAggregate({ businessDate, routeIds: scope.routeIds });
  const routeIdsSeen = routeRows.map((row) => Number(row.routeId));

  // Not raw: model instances expose the camelCase attributes (routeCode), which
  // is what the response shape uses.
  const routes = routeIdsSeen.length ? await Route.findAll({ where: { id: { [Op.in]: routeIdsSeen } } }) : [];
  const routeById = new Map(routes.map((route) => [route.id, route]));

  // One query for every route's collectors — not one per route.
  const collectorRows = routeIdsSeen.length
    ? await RouteCollector.findAll({
        where: { routeId: { [Op.in]: routeIdsSeen }, status: ASSIGNMENT_STATUS.ACTIVE },
        include: [{ association: 'Collector', attributes: ['id', 'name', 'email'] }]
      })
    : [];

  const collectorsByRoute = collectorRows.reduce((accumulator, row) => {
    (accumulator[row.routeId] = accumulator[row.routeId] || []).push({ id: row.Collector?.id, name: row.Collector?.name });
    return accumulator;
  }, {});

  const routePerformance = routeRows
    .map((row) => {
      const routeId = Number(row.routeId);
      const route = routeById.get(routeId);
      const dueValuePaise = toPaise(String(row.dueValue ?? '0'));
      const collectedPaise = toPaise(String(row.collectedOnDue ?? '0'));

      return {
        route: route ? { id: route.id, routeCode: route.routeCode, name: route.name, status: route.status } : null,
        collectors: collectorsByRoute[routeId] ?? [],
        collectorNames: (collectorsByRoute[routeId] ?? []).map((c) => c.name).join('; '),
        activeLoans: Number(row.loanCount ?? 0),
        dueEmiCount: Number(row.dueEmiCount ?? 0),
        dueValue: fromPaise(dueValuePaise),
        collected: fromPaise(collectedPaise),
        outstanding: fromPaise(dueValuePaise - collectedPaise),
        overdueAmount: fromPaise(toPaise(String(row.overdueAmount ?? '0'))),
        overdueCount: Number(row.overdueCount ?? 0),
        dueTodayAmount: fromPaise(toPaise(String(row.dueTodayAmount ?? '0'))),
        partialCount: Number(row.partialCount ?? 0),
        efficiencyPercent: efficiencyPercent(collectedPaise, dueValuePaise)
      };
    })
    .sort((a, b) => toPaise(b.outstanding) > toPaise(a.outstanding) ? 1 : -1)
    .slice(0, MAX_PERFORMANCE_ROWS);

  /* ------------------------------------------------ collector performance */

  // Derived by folding route rows, so adding collectors costs no extra queries.
  const collectorMap = new Map();
  for (const routeRow of routePerformance) {
    for (const collector of routeRow.collectors) {
      if (!collector?.id) continue;
      if (!collectorMap.has(collector.id)) {
        collectorMap.set(collector.id, {
          collector: { id: collector.id, name: collector.name },
          routes: [],
          activeLoans: 0,
          duePaise: 0n,
          collectedPaise: 0n,
          overduePaise: 0n,
          overdueCount: 0,
          partialCount: 0
        });
      }
      const entry = collectorMap.get(collector.id);
      entry.routes.push(routeRow.route?.routeCode);
      entry.activeLoans += routeRow.activeLoans;
      entry.duePaise += toPaise(routeRow.dueValue);
      entry.collectedPaise += toPaise(routeRow.collected);
      entry.overduePaise += toPaise(routeRow.overdueAmount);
      entry.overdueCount += routeRow.overdueCount;
      entry.partialCount += routeRow.partialCount;
    }
  }

  const collectorPerformance = [...collectorMap.values()]
    .map((entry) => ({
      collector: entry.collector,
      routes: entry.routes.filter(Boolean),
      routeCount: entry.routes.length,
      activeLoans: entry.activeLoans,
      dueValue: fromPaise(entry.duePaise),
      collected: fromPaise(entry.collectedPaise),
      outstanding: fromPaise(entry.duePaise - entry.collectedPaise),
      overdueAmount: fromPaise(entry.overduePaise),
      overdueCount: entry.overdueCount,
      partialCount: entry.partialCount,
      efficiencyPercent: efficiencyPercent(entry.collectedPaise, entry.duePaise)
    }))
    .sort((a, b) => (b.efficiencyPercent ?? -1) - (a.efficiencyPercent ?? -1));

  /* ------------------------------------------------------------- alerts */

  const alerts = buildAlerts({
    overallDue,
    emiTotals: emiTotals.summary,
    routePerformance,
    periodCollections: periodCollections.summary,
    businessDate
  });

  /* ------------------------------------------------------------ response */

  return {
    period: { ...period, generatedAt: new Date().toISOString() },
    scope: { restricted: scope.scoped, routeIds: scope.routeIds },

    loans: {
      activeCount: statusCounts[LOAN_STATUS.ACTIVE] ?? 0,
      draftCount: statusCounts[LOAN_STATUS.DRAFT] ?? 0,
      closedCount: statusCounts[LOAN_STATUS.CLOSED] ?? 0,
      cancelledCount: statusCounts[LOAN_STATUS.CANCELLED] ?? 0,
      newInPeriod: newLoansInPeriod,
      activePrincipal: activeLoans.summary.totalLoanAmount,
      activeRepayment: activeLoans.summary.totalRepayment,
      activeCollected: activeLoans.summary.totalCollected,
      activeOutstanding: activeLoans.summary.totalOutstanding
    },

    emi: {
      asOf: businessDate,
      scheduledCount: emiTotals.summary.emiCount,
      totalScheduled: emiTotals.summary.totalEmiAmount,
      totalCollected: emiTotals.summary.totalCollected,
      totalOutstanding: emiTotals.summary.totalOutstanding,
      dueTodayAmount: fromPaise(toPaise(String(overallDue.dueTodayAmount ?? '0'))),
      overdueAmount: fromPaise(toPaise(String(overallDue.overdueAmount ?? '0'))),
      overdueCount: Number(overallDue.overdueCount ?? 0),
      // Distinct loans behind those instalments: three missed instalments on one
      // loan are one overdue borrower, not three. Same predicate as
      // overdueCount, same query, so both obey every dashboard filter.
      overdueLoanCount: Number(overallDue.overdueLoanCount ?? 0),
      partialCount: Number(overallDue.partialCount ?? 0)
    },

    demand: {
      asOf: businessDate,
      // Straight from the demand service — the authority on demand.
      todayDemand: demandToday.summary.totalDemand,
      dueTodayAmount: demandToday.summary.dueTodayAmount,
      dueTodayCount: demandToday.summary.dueTodayCount,
      overdueAmount: demandToday.summary.overdueAmount,
      overdueCount: demandToday.summary.overdueCount,
      demandEmiCount: demandToday.summary.emiCount,
      maxDpd: demandToday.summary.maxDpd
    },

    collections: {
      // Says in the payload itself what the bounce figures below mean, the same
      // way `efficiency.definition` does for the ratio.
      bounceDefinition: BOUNCE_COLLECTION_DEFINITION,
      today: {
        date: businessDate,
        postedAmount: todayCollections.summary.postedAmount,
        postedCount: todayCollections.summary.postedCount,
        reversedAmount: todayCollections.summary.reversedAmount,
        reversedCount: todayCollections.summary.reversedCount,
        // postedAmount split in two: instalment money and bounce money. Both
        // come from the collection report, so neither is a second calculation.
        emiCollection: todayCollections.summary.emiCollected,
        bounceCollection: todayCollections.summary.collectedBounce,
        bounceCollectionCount: todayCollections.summary.bounceCollectionCount
      },
      period: {
        from,
        to,
        postedAmount: periodCollections.summary.postedAmount,
        postedCount: periodCollections.summary.postedCount,
        reversedAmount: periodCollections.summary.reversedAmount,
        reversedCount: periodCollections.summary.reversedCount,
        emiCollection: periodCollections.summary.emiCollected,
        bounceCollection: periodCollections.summary.collectedBounce,
        bounceCollectionCount: periodCollections.summary.bounceCollectionCount,
        averageCollection:
          periodCollections.summary.postedCount > 0
            ? fromPaise(divideRoundHalfUp(toPaise(periodCollections.summary.postedAmount), BigInt(periodCollections.summary.postedCount)))
            : '0.00'
      }
    },

    efficiency: {
      definition: EFFICIENCY_DEFINITION,
      asOf: businessDate,
      dueValue: fromPaise(duePaise),
      collected: fromPaise(collectedOnDuePaise),
      outstanding: fromPaise(duePaise - collectedOnDuePaise),
      percent: efficiencyPercent(collectedOnDuePaise, duePaise)
    },

    routes: routePerformance,
    collectors: collectorPerformance,
    alerts
  };
}

/**
 * Operational alerts — facts only.
 *
 * Each is a count or an amount already present in the data, with a link to the
 * page that shows the detail. No scoring, no weighting, no invented thresholds
 * beyond "greater than zero".
 */
function buildAlerts({ overallDue, routePerformance, periodCollections, businessDate }) {
  const alerts = [];

  const overdueCount = Number(overallDue.overdueCount ?? 0);
  const overduePaise = toPaise(String(overallDue.overdueAmount ?? '0'));
  if (overdueCount > 0) {
    alerts.push({
      type: ALERT_TYPES.OVERDUE_EMIS,
      severity: ALERT_SEVERITY.CRITICAL,
      title: `${overdueCount} overdue instalment${overdueCount === 1 ? '' : 's'}`,
      detail: `${fromPaise(overduePaise)} outstanding past its due date as of ${businessDate}.`,
      count: overdueCount,
      amount: fromPaise(overduePaise),
      link: '/reports/emis?status=OVERDUE'
    });
  }

  const partialCount = Number(overallDue.partialCount ?? 0);
  if (partialCount > 0) {
    alerts.push({
      type: ALERT_TYPES.PARTIAL_EMIS,
      severity: ALERT_SEVERITY.WARNING,
      title: `${partialCount} partially paid instalment${partialCount === 1 ? '' : 's'}`,
      detail: 'These instalments have received money but are not settled.',
      count: partialCount,
      link: '/reports/emis?status=PARTIAL'
    });
  }

  const worstRoute = [...routePerformance].sort((a, b) => (toPaise(b.overdueAmount) > toPaise(a.overdueAmount) ? 1 : -1))[0];
  if (worstRoute && toPaise(worstRoute.overdueAmount) > 0n) {
    alerts.push({
      type: ALERT_TYPES.ROUTE_OUTSTANDING,
      severity: ALERT_SEVERITY.WARNING,
      title: `${worstRoute.route?.routeCode ?? 'A route'} carries the highest overdue amount`,
      detail: `${worstRoute.overdueAmount} overdue across ${worstRoute.overdueCount} instalment(s).`,
      amount: worstRoute.overdueAmount,
      link: worstRoute.route ? `/routes/${worstRoute.route.id}` : '/routes'
    });
  }

  const routesWithoutCollector = routePerformance.filter((row) => row.collectors.length === 0);
  if (routesWithoutCollector.length > 0) {
    alerts.push({
      type: ALERT_TYPES.ROUTE_WITHOUT_COLLECTOR,
      severity: ALERT_SEVERITY.WARNING,
      title: `${routesWithoutCollector.length} route${routesWithoutCollector.length === 1 ? '' : 's'} with loans but no collector`,
      detail: routesWithoutCollector.map((row) => row.route?.routeCode).filter(Boolean).join(', '),
      count: routesWithoutCollector.length,
      link: '/routes'
    });
  }

  if (Number(periodCollections.reversedCount ?? 0) > 0) {
    alerts.push({
      type: ALERT_TYPES.REVERSED_COLLECTIONS,
      severity: ALERT_SEVERITY.INFO,
      title: `${periodCollections.reversedCount} reversed collection${periodCollections.reversedCount === 1 ? '' : 's'} in this period`,
      detail: `${periodCollections.reversedAmount} was reversed and does not count toward collected totals.`,
      count: periodCollections.reversedCount,
      amount: periodCollections.reversedAmount,
      link: '/reports/collections?status=REVERSED'
    });
  }

  return alerts;
}

module.exports = {
  getDashboard,
  efficiencyPercent,
  routeAggregate,
  overallDueAggregate,
  EFFICIENCY_DEFINITION,
  BOUNCE_COLLECTION_DEFINITION
};
