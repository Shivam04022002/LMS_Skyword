'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { sequelize, Loan, EmiSchedule, Collection } = require('../models');
const ApiError = require('../utils/ApiError');
const reportService = require('./reportService');
const collectionAllocationService = require('./collectionAllocationService');
const { toPaise, fromPaise } = require('../utils/money');
const { today, differenceInDays } = require('../utils/dates');
const { LOAN_STATUS_VALUES, LOAN_TYPE_VALUES } = require('../config/loans');
const { EMI_STATUS, EMI_STATUS_VALUES, TERMINAL_EMI_STATUSES } = require('../config/emis');
const { COLLECTION_STATUS, LEDGER_TYPE_VALUES } = require('../config/collections');
const {
  ANALYTICS_SECTIONS,
  ANALYTICS_BUCKETS,
  ANALYTICS_MAX_POINTS,
  ANALYTICS_MAX_CATEGORIES
} = require('../config/reports');

/**
 * Graph & Analytics — read-only aggregation for the chart page.
 *
 * NOT A SECOND SOURCE OF TRUTH. Every figure here is the same stored column the
 * five existing reports read, aggregated by SQL instead of listed as rows:
 *
 *   loan count / amount        loans.loan_amount, loans.status, loans.loan_type
 *   instalment demand          emi_schedules.emi_amount
 *   instalment collected       emi_schedules.amount_collected, which the
 *                              collection service rebuilds from the allocation
 *                              ledger on every posting and reversal — so a
 *                              reversed collection is already excluded without
 *                              any payment logic being restated here
 *   collected money            collections.amount, POSTED only
 *   principal / interest       collectionAllocationService.allocationBreakdown
 *   bounce COLLECTED           collectionAllocationService.bounceCollected,
 *                              i.e. collections.bounce_amount
 *   bounce ASSESSED            emi_schedules.bounce_charge
 *
 * Scoping, including a COLLECTOR's confinement to their own routes, is
 * `reportService.resolveScope` — the same function every report uses, so this
 * page cannot show a caller anything the reports would not.
 *
 * ── ASSESSED IS NOT COLLECTED ─────────────────────────────────────────────────
 * `emi_schedules.bounce_charge` is a charge that was levied. `collections.
 * bounce_amount` is money that arrived. They are reported as two separate
 * series and are never added together, so an unpaid charge contributes nothing
 * to any collected figure.
 *
 * ── WHAT "DEMAND OVER TIME" MEANS HERE ────────────────────────────────────────
 * Demand is an as-of-a-date quantity: demandService answers "what is collectable
 * today". A time series of that would mean re-evaluating the whole book once per
 * point, which is a full scan per bucket. So the series here is demand grouped
 * by THE PERIOD AN INSTALMENT FELL DUE, split into overdue / due-today /
 * upcoming relative to `asOf` by exactly the comparison demandService's
 * `bucketFor` makes. Summed over a window that covers the whole book it equals
 * demandService's own totals for the same `asOf`; read per bucket it says which
 * periods the outstanding demand came from. The page says so too — it is not
 * labelled as a daily re-evaluation, because it is not one.
 *
 * Nothing in this file writes.
 */

/* ------------------------------------------------------------------ bucketing */

/**
 * The SQL expression that collapses a date column into its bucket.
 *
 * Week starts Monday (WEEKDAY() is 0 on Monday), month on the 1st. The result is
 * a DATE in every case, so a series point is always a real date the frontend can
 * sort and format, never a "2026-W07" string that needs parsing back.
 */
function bucketExpression(column, bucket) {
  switch (bucket) {
    case ANALYTICS_BUCKETS.WEEK:
      return `DATE_SUB(${column}, INTERVAL WEEKDAY(${column}) DAY)`;
    case ANALYTICS_BUCKETS.MONTH:
      return `DATE_FORMAT(${column}, '%Y-%m-01')`;
    case ANALYTICS_BUCKETS.DAY:
    default:
      return `DATE(${column})`;
  }
}

/**
 * Refuses a series that would be too long to draw, rather than trimming it.
 *
 * A truncated series draws a trend that stops short of its own data, which is
 * worse than an error: the chart looks complete and is not.
 */
function assertSeriesSize(points, { what = 'series', hint = 'Narrow the date range or group by week or month.' } = {}) {
  if (points > ANALYTICS_MAX_POINTS) {
    throw ApiError.badRequest(
      `This ${what} would contain ${points} points, above the ${ANALYTICS_MAX_POINTS} a chart can show. ${hint}`
    );
  }
  return points;
}

function assertCategorySize(categories, what) {
  if (categories > ANALYTICS_MAX_CATEGORIES) {
    throw ApiError.badRequest(
      `This chart would contain ${categories} ${what}, above the ${ANALYTICS_MAX_CATEGORIES} it can show. Narrow the filters and try again.`
    );
  }
  return categories;
}

/** How many buckets a window spans, so an oversized request is refused before it runs. */
function bucketsInWindow(from, to, bucket) {
  const days = Math.abs(differenceInDays(from, to)) + 1;
  if (bucket === ANALYTICS_BUCKETS.MONTH) return Math.ceil(days / 28) + 1;
  if (bucket === ANALYTICS_BUCKETS.WEEK) return Math.ceil(days / 7) + 1;
  return days;
}

/* -------------------------------------------------------------------- helpers */

const money = (value) => fromPaise(toPaise(String(value ?? '0')));

/**
 * A date as a quoted SQL literal.
 *
 * The validator has already rejected anything that is not YYYY-MM-DD, so this
 * cannot be reached with hostile input — it is here so that stays true if the
 * validator ever changes, and because escaping belongs to Sequelize rather than
 * to string interpolation.
 */
const sqlDate = (value) => sequelize.escape(String(value));

/** A date column's value as YYYY-MM-DD, whatever the driver hands back. */
const isoDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

/**
 * The window every date series is cut to.
 *
 * Defaulted rather than unbounded: without a from/to an analytics request would
 * group the entire book, which is both unreadable and a full scan. Twelve months
 * back from the as-of date is the default window.
 */
function resolveWindow({ dateFrom, dateTo, asOf }) {
  const to = dateTo || asOf;
  const from = dateFrom || `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
  if (differenceInDays(from, to) < 0) {
    throw ApiError.badRequest('The date range ends before it begins — check the From and To dates');
  }
  return { from, to };
}

/**
 * The loan-id restriction a scoped caller is confined to, or null for no
 * restriction. `[0]` when the scope resolves to no loans at all, so the query
 * returns nothing rather than everything.
 */
async function scopeLoanIds(scope) {
  if (scope.routeIds === null) return null;
  const loanIds = await reportService.loanIdsForRoutes(scope.routeIds);
  return loanIds.length === 0 ? [0] : loanIds;
}

/* ---------------------------------------------------------- loan analytics (A) */

async function loanAnalytics({ filters, scope, window, bucket }) {
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.loanType) where.loanType = filters.loanType;

  const loanIds = await scopeLoanIds(scope);
  if (loanIds) where.id = { [Op.in]: loanIds };

  // Total loans by status — every status present, so a chart shows a real zero
  // for a status with no loans rather than omitting the slice.
  const statusRows = await Loan.findAll({
    attributes: ['status', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('loan_amount')), 0), 'amount']],
    where,
    group: ['status'],
    raw: true
  });
  const byStatusMap = new Map(statusRows.map((row) => [row.status, row]));
  const byStatus = LOAN_STATUS_VALUES.map((status) => ({
    label: status,
    count: Number(byStatusMap.get(status)?.count ?? 0),
    amount: money(byStatusMap.get(status)?.amount)
  }));

  // Loan amount by type.
  const typeRows = await Loan.findAll({
    attributes: ['loanType', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('loan_amount')), 0), 'amount']],
    where,
    group: ['loanType'],
    raw: true
  });
  const byTypeMap = new Map(typeRows.map((row) => [row.loanType, row]));
  const byType = LOAN_TYPE_VALUES.map((loanType) => ({
    label: loanType,
    count: Number(byTypeMap.get(loanType)?.count ?? 0),
    amount: money(byTypeMap.get(loanType)?.amount)
  }));

  // Disbursement over time, by the loan's start date — the date the contract
  // runs from, which is what the loan report filters on too.
  const startBucket = bucketExpression('`Loan`.`start_date`', bucket);
  const disbursed = await Loan.findAll({
    attributes: [
      [literal(startBucket), 'bucket'],
      [fn('COUNT', col('Loan.id')), 'count'],
      [fn('COALESCE', fn('SUM', col('loan_amount')), 0), 'amount']
    ],
    where: { ...where, startDate: { [Op.between]: [window.from, window.to] } },
    group: [literal(startBucket)],
    order: [literal(`${startBucket} ASC`)],
    raw: true
  });

  // Loans created over time, by created_at — when the record was entered, which
  // is a different question from when its term starts.
  const createdBucket = bucketExpression('`Loan`.`created_at`', bucket);
  const created = await Loan.findAll({
    attributes: [
      [literal(createdBucket), 'bucket'],
      [fn('COUNT', col('Loan.id')), 'count'],
      [fn('COALESCE', fn('SUM', col('loan_amount')), 0), 'amount']
    ],
    where: { ...where, createdAt: { [Op.between]: [`${window.from} 00:00:00`, `${window.to} 23:59:59`] } },
    group: [literal(createdBucket)],
    order: [literal(`${createdBucket} ASC`)],
    raw: true
  });

  assertSeriesSize(Math.max(disbursed.length, created.length), { what: 'loan series' });

  const series = (rows) => rows.map((row) => ({ label: isoDate(row.bucket), date: isoDate(row.bucket), count: Number(row.count), amount: money(row.amount) }));

  return {
    charts: {
      loansByStatus: { title: 'Loans by status', kind: 'category', points: byStatus },
      loanAmountByType: { title: 'Loan amount by type', kind: 'category', points: byType },
      disbursementOverTime: { title: 'Loan disbursement over time', kind: 'series', points: series(disbursed) },
      loansCreatedOverTime: { title: 'Loans created over time', kind: 'series', points: series(created) }
    },
    summary: {
      loanCount: byStatus.reduce((total, point) => total + point.count, 0),
      loanAmount: fromPaise(byStatus.reduce((total, point) => total + toPaise(point.amount), 0n))
    }
  };
}

/* -------------------------------------------------------- demand analytics (B) */

/**
 * Instalment demand, grouped by the period it fell due.
 *
 * The demandable set and the overdue / due-today / upcoming split are the same
 * rules demandService applies: an instalment still owes money when it is not
 * WAIVED and `amount_collected < emi_amount`, and its bucket is decided by its
 * due date against `asOf`. Expressed in SQL here so one query answers the whole
 * series instead of one evaluation per point.
 */
async function demandAnalytics({ scope, window, bucket, asOf }) {
  const loanIds = await scopeLoanIds(scope);

  const owing = [
    { status: { [Op.notIn]: TERMINAL_EMI_STATUSES } },
    literal('`EmiSchedule`.`amount_collected` < `EmiSchedule`.`emi_amount`')
  ];
  const where = { [Op.and]: owing, emiDate: { [Op.between]: [window.from, window.to] } };
  if (loanIds) where.loanId = { [Op.in]: loanIds };

  const dateBucket = bucketExpression('`EmiSchedule`.`emi_date`', bucket);
  const outstanding = '(`EmiSchedule`.`emi_amount` - `EmiSchedule`.`amount_collected`)';

  const rows = await EmiSchedule.findAll({
    attributes: [
      [literal(dateBucket), 'bucket'],
      [fn('COUNT', col('EmiSchedule.id')), 'count'],
      [literal(`COALESCE(SUM(\`EmiSchedule\`.\`emi_amount\`), 0)`), 'gross'],
      [literal(`COALESCE(SUM(${outstanding}), 0)`), 'net'],
      // The same three-way split bucketFor makes, in one pass.
      [literal(`COALESCE(SUM(CASE WHEN \`EmiSchedule\`.\`emi_date\` < ${sqlDate(asOf)} THEN ${outstanding} ELSE 0 END), 0)`), 'overdue'],
      [literal(`COALESCE(SUM(CASE WHEN \`EmiSchedule\`.\`emi_date\` = ${sqlDate(asOf)} THEN ${outstanding} ELSE 0 END), 0)`), 'dueToday'],
      [literal(`COALESCE(SUM(CASE WHEN \`EmiSchedule\`.\`emi_date\` > ${sqlDate(asOf)} THEN ${outstanding} ELSE 0 END), 0)`), 'upcoming']
    ],
    where,
    group: [literal(dateBucket)],
    order: [literal(`${dateBucket} ASC`)],
    raw: true
  });

  assertSeriesSize(rows.length, { what: 'demand series' });

  const points = rows.map((row) => ({
    label: isoDate(row.bucket),
    date: isoDate(row.bucket),
    count: Number(row.count),
    amount: money(row.net),
    gross: money(row.gross),
    net: money(row.net),
    overdue: money(row.overdue),
    dueToday: money(row.dueToday),
    upcoming: money(row.upcoming)
  }));

  // Demand by route, over the same window and the same owing rule.
  const byRoute = await demandByRoute({ where, scope });

  const sum = (field) => fromPaise(points.reduce((total, point) => total + toPaise(point[field]), 0n));

  return {
    charts: {
      demandOverTime: {
        title: 'Demand by the period it fell due',
        kind: 'series',
        note: `Outstanding instalment value, split against ${asOf}. Not a daily re-evaluation of the whole book.`,
        points,
        seriesKeys: [
          { key: 'gross', label: 'Gross demand' },
          { key: 'net', label: 'Net outstanding' },
          { key: 'overdue', label: 'Overdue' },
          { key: 'dueToday', label: 'Due today' },
          { key: 'upcoming', label: 'Upcoming' }
        ]
      },
      demandByRoute: { title: 'Demand by route', kind: 'category', points: byRoute }
    },
    summary: {
      emiCount: points.reduce((total, point) => total + point.count, 0),
      grossDemand: sum('gross'),
      netDemand: sum('net')
    }
  };
}

/**
 * Demand grouped by the route a loan is currently assigned to.
 *
 * Two queries: the per-loan totals, then the route of each loan through the same
 * `routeContextForLoans` the reports use. Grouping in SQL by route would need a
 * join through loan_routes that the existing reports deliberately do not make,
 * so this follows their shape rather than inventing a different one.
 */
async function demandByRoute({ where }) {
  const rows = await EmiSchedule.findAll({
    attributes: [
      'loanId',
      [fn('COUNT', col('EmiSchedule.id')), 'count'],
      [literal('COALESCE(SUM(`EmiSchedule`.`emi_amount` - `EmiSchedule`.`amount_collected`), 0)'), 'net']
    ],
    where,
    group: ['loanId'],
    raw: true
  });

  return groupByRoute(rows, { amountField: 'net' });
}

/** Collapses per-loan rows into per-route points, using the reports' own route lookup. */
async function groupByRoute(rows, { amountField }) {
  const loanIds = [...new Set(rows.map((row) => Number(row.loanId)))];
  const { routeByLoan } = await routeContext(loanIds);

  const groups = new Map();
  for (const row of rows) {
    const route = routeByLoan.get(Number(row.loanId)) ?? null;
    const key = route ? route.routeCode : 'Unrouted';
    if (!groups.has(key)) groups.set(key, { label: key, routeName: route?.name ?? null, count: 0, paise: 0n });
    const group = groups.get(key);
    group.count += Number(row.count ?? 0);
    group.paise += toPaise(String(row[amountField] ?? '0'));
  }

  const points = [...groups.values()]
    .map((group) => ({ label: group.label, routeName: group.routeName, count: group.count, amount: fromPaise(group.paise) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  assertCategorySize(points.length, 'routes');
  return points;
}

/*
 * The reports' route lookup, reached through reportService so there is one
 * implementation. It is not exported, so this mirrors the two queries it makes
 * rather than duplicating its mapping logic in SQL.
 */
async function routeContext(loanIds) {
  if (loanIds.length === 0) return { routeByLoan: new Map() };
  const { LoanRoute } = require('../models');
  const { ASSIGNMENT_STATUS } = require('../config/routes');

  const assignments = await LoanRoute.findAll({
    where: { loanId: { [Op.in]: loanIds }, status: ASSIGNMENT_STATUS.ACTIVE },
    include: [{ association: 'Route', attributes: ['id', 'routeCode', 'name'] }]
  });

  return { routeByLoan: new Map(assignments.map((a) => [a.loanId, a.Route])) };
}

/* ---------------------------------------------------- collection analytics (C) */

async function collectionAnalytics({ filters, scope, window, bucket }) {
  const loanIds = await scopeLoanIds(scope);

  // POSTED only, exactly as the collection report's netCollected is.
  const where = {
    status: COLLECTION_STATUS.POSTED,
    collectionDate: { [Op.between]: [window.from, window.to] }
  };
  if (filters.ledgerType) where.ledgerType = filters.ledgerType;
  if (loanIds) where.loanId = { [Op.in]: loanIds };

  const dateBucket = bucketExpression('`Collection`.`collection_date`', bucket);
  const emiPortion = '(`Collection`.`amount` - `Collection`.`bounce_amount`)';

  const rows = await Collection.findAll({
    attributes: [
      [literal(dateBucket), 'bucket'],
      [fn('COUNT', col('Collection.id')), 'count'],
      [literal('COALESCE(SUM(`Collection`.`amount`), 0)'), 'amount'],
      // The two halves of amount, never added to it.
      [literal(`COALESCE(SUM(${emiPortion}), 0)`), 'emiAmount'],
      [literal('COALESCE(SUM(`Collection`.`bounce_amount`), 0)'), 'bounceAmount']
    ],
    where,
    group: [literal(dateBucket)],
    order: [literal(`${dateBucket} ASC`)],
    raw: true
  });

  assertSeriesSize(rows.length, { what: 'collection series' });

  const points = rows.map((row) => ({
    label: isoDate(row.bucket),
    date: isoDate(row.bucket),
    count: Number(row.count),
    amount: money(row.amount),
    emiCollected: money(row.emiAmount),
    bounceCollected: money(row.bounceAmount)
  }));

  // By payment mode, every mode present so a zero reads as a zero.
  const modeRows = await Collection.findAll({
    attributes: ['ledgerType', [fn('COUNT', col('id')), 'count'], [literal('COALESCE(SUM(`Collection`.`amount`), 0)'), 'amount']],
    where,
    group: ['ledgerType'],
    raw: true
  });
  const modeMap = new Map(modeRows.map((row) => [row.ledgerType, row]));
  const byMode = LEDGER_TYPE_VALUES.map((ledgerType) => ({
    label: ledgerType,
    count: Number(modeMap.get(ledgerType)?.count ?? 0),
    amount: money(modeMap.get(ledgerType)?.amount)
  }));

  // By route.
  const perLoan = await Collection.findAll({
    attributes: ['loanId', [fn('COUNT', col('id')), 'count'], [literal('COALESCE(SUM(`Collection`.`amount`), 0)'), 'amount']],
    where,
    group: ['loanId'],
    raw: true
  });
  const byRoute = await groupByRoute(perLoan, { amountField: 'amount' });

  /*
   * Principal and interest for the SAME filtered set, from the allocation
   * ledger via the existing breakdown — not recomputed, and not derived from the
   * collection amount. Bounce is the part that was never allocated to an
   * instalment, so principal + interest + bounce = the collected total exactly.
   */
  const { totals } = await collectionAllocationService.allocationBreakdown(where);
  const { bounceCollection, bounceCollectionCount } = await collectionAllocationService.bounceCollected(where);

  const sum = (field) => fromPaise(points.reduce((total, point) => total + toPaise(point[field]), 0n));

  return {
    charts: {
      collectionsOverTime: {
        title: 'Collections over time',
        kind: 'series',
        points,
        seriesKeys: [
          { key: 'amount', label: 'Total collected' },
          { key: 'emiCollected', label: 'Instalment portion' },
          { key: 'bounceCollected', label: 'Bounce portion' }
        ]
      },
      principalVsInterest: {
        title: 'Principal vs interest collected',
        kind: 'category',
        note: 'Apportioned from the allocation ledger. Bounce is shown beside them because it is allocated to no instalment.',
        points: [
          { label: 'Principal', count: null, amount: totals.collectedPrincipal },
          { label: 'Interest', count: null, amount: totals.collectedInterest },
          { label: 'Bounce', count: bounceCollectionCount, amount: bounceCollection }
        ]
      },
      collectionsByRoute: { title: 'Collections by route', kind: 'category', points: byRoute },
      collectionsByMode: { title: 'Collections by payment mode', kind: 'category', points: byMode }
    },
    summary: {
      collectionCount: points.reduce((total, point) => total + point.count, 0),
      collected: sum('amount'),
      emiCollected: totals.emiCollected,
      collectedPrincipal: totals.collectedPrincipal,
      collectedInterest: totals.collectedInterest,
      bounceCollected: bounceCollection,
      bounceCollectionCount
    }
  };
}

/* ----------------------------------------------------------- EMI analytics (D) */

async function emiAnalytics({ filters, scope, window, bucket, asOf }) {
  const loanIds = await scopeLoanIds(scope);

  const base = { emiDate: { [Op.between]: [window.from, window.to] } };
  if (loanIds) base.loanId = { [Op.in]: loanIds };

  /*
   * Status distribution. Each count uses reportService.emiStatusPredicate, the
   * same SQL the EMI report filters with, so a slice here and a filtered EMI
   * report for the same status return the same number. The statuses are DERIVED,
   * which is why this is one COUNT per status rather than a GROUP BY on a column
   * that does not hold the answer.
   */
  const statusDistribution = [];
  for (const status of EMI_STATUS_VALUES) {
    const predicate = reportService.emiStatusPredicate(status, asOf);
    // eslint-disable-next-line no-await-in-loop
    const [row] = await EmiSchedule.findAll({
      attributes: [
        [fn('COUNT', col('EmiSchedule.id')), 'count'],
        [literal('COALESCE(SUM(`EmiSchedule`.`emi_amount`), 0)'), 'amount']
      ],
      where: { [Op.and]: [base, predicate] },
      raw: true
    });
    statusDistribution.push({ label: status, count: Number(row?.count ?? 0), amount: money(row?.amount) });
  }

  // Demand vs collected, and outstanding, by the period the instalment fell due.
  const dateBucket = bucketExpression('`EmiSchedule`.`emi_date`', bucket);
  const where = { ...base };
  if (filters.emiStatus) where[Op.and] = [reportService.emiStatusPredicate(filters.emiStatus, asOf)];

  const rows = await EmiSchedule.findAll({
    attributes: [
      [literal(dateBucket), 'bucket'],
      [fn('COUNT', col('EmiSchedule.id')), 'count'],
      [literal('COALESCE(SUM(`EmiSchedule`.`emi_amount`), 0)'), 'demand'],
      [literal('COALESCE(SUM(`EmiSchedule`.`amount_collected`), 0)'), 'collected'],
      [
        literal(
          'COALESCE(SUM(GREATEST(`EmiSchedule`.`emi_amount` - `EmiSchedule`.`amount_collected`, 0)), 0)'
        ),
        'outstanding'
      ]
    ],
    where,
    group: [literal(dateBucket)],
    order: [literal(`${dateBucket} ASC`)],
    raw: true
  });

  assertSeriesSize(rows.length, { what: 'instalment series' });

  const points = rows.map((row) => ({
    label: isoDate(row.bucket),
    date: isoDate(row.bucket),
    count: Number(row.count),
    amount: money(row.demand),
    demand: money(row.demand),
    collected: money(row.collected),
    outstanding: money(row.outstanding)
  }));

  const dpdDistribution = await dpdBuckets({ base, asOf });

  const sum = (field) => fromPaise(points.reduce((total, point) => total + toPaise(point[field]), 0n));

  return {
    charts: {
      emiStatusDistribution: { title: 'Instalment status distribution', kind: 'category', points: statusDistribution },
      emiDemandVsCollected: {
        title: 'Instalment demand vs collected',
        kind: 'series',
        points,
        seriesKeys: [
          { key: 'demand', label: 'Instalment demand' },
          { key: 'collected', label: 'Collected' }
        ]
      },
      emiOutstandingOverTime: {
        title: 'Outstanding instalment amount over time',
        kind: 'series',
        points,
        seriesKeys: [{ key: 'outstanding', label: 'Outstanding' }]
      },
      dpdDistribution: { title: 'DPD distribution', kind: 'category', points: dpdDistribution }
    },
    summary: {
      emiCount: points.reduce((total, point) => total + point.count, 0),
      emiAmount: sum('demand'),
      emiAmountCollected: sum('collected'),
      emiOutstanding: sum('outstanding')
    }
  };
}

/**
 * Days past due, bucketed.
 *
 * DPD is `EmiSchedule.computeDpd`: zero when the instalment is terminal or owes
 * nothing, otherwise the days since its due date. The SQL below is that rule and
 * nothing else — `DATEDIFF(asOf, emi_date)` over rows that are not WAIVED and
 * still owe money, which is exactly what the model returns for them.
 */
async function dpdBuckets({ base, asOf }) {
  const BANDS = [
    { label: 'Not overdue', min: 0, max: 0 },
    { label: '1-7 days', min: 1, max: 7 },
    { label: '8-15 days', min: 8, max: 15 },
    { label: '16-30 days', min: 16, max: 30 },
    { label: '31-60 days', min: 31, max: 60 },
    { label: '60+ days', min: 61, max: null }
  ];

  const owing = [
    { status: { [Op.notIn]: TERMINAL_EMI_STATUSES } },
    literal('`EmiSchedule`.`amount_collected` < `EmiSchedule`.`emi_amount`')
  ];
  const dpd = `GREATEST(DATEDIFF(${sqlDate(asOf)}, \`EmiSchedule\`.\`emi_date\`), 0)`;

  const caseFor = (band) =>
    band.max === null ? `${dpd} >= ${band.min}` : `${dpd} BETWEEN ${band.min} AND ${band.max}`;

  const [row] = await EmiSchedule.findAll({
    attributes: BANDS.flatMap((band, index) => [
      [literal(`COALESCE(SUM(CASE WHEN ${caseFor(band)} THEN 1 ELSE 0 END), 0)`), `count${index}`],
      [
        literal(
          `COALESCE(SUM(CASE WHEN ${caseFor(band)} THEN GREATEST(\`EmiSchedule\`.\`emi_amount\` - \`EmiSchedule\`.\`amount_collected\`, 0) ELSE 0 END), 0)`
        ),
        `amount${index}`
      ]
    ]),
    where: { [Op.and]: [base, ...owing] },
    raw: true
  });

  return BANDS.map((band, index) => ({
    label: band.label,
    count: Number(row?.[`count${index}`] ?? 0),
    amount: money(row?.[`amount${index}`])
  }));
}

/* -------------------------------------------------------- bounce analytics (E) */

/**
 * Bounce, assessed and collected, kept apart.
 *
 * ASSESSED is `emi_schedules.bounce_charge` — a fee levied on an instalment,
 * grouped by the period that instalment fell due. COLLECTED is
 * `collections.bounce_amount` — money that arrived — grouped by the period it
 * was received in. They are different quantities measured on different dates
 * and they are returned as separate charts. Nothing here adds them, and the
 * assessed figure never contributes to a collected total.
 */
async function bounceAnalytics({ scope, window, bucket }) {
  const loanIds = await scopeLoanIds(scope);

  const assessedWhere = {
    emiDate: { [Op.between]: [window.from, window.to] },
    bounceCharge: { [Op.gt]: 0 }
  };
  if (loanIds) assessedWhere.loanId = { [Op.in]: loanIds };

  const emiBucket = bucketExpression('`EmiSchedule`.`emi_date`', bucket);
  const assessedRows = await EmiSchedule.findAll({
    attributes: [
      [literal(emiBucket), 'bucket'],
      [fn('COUNT', col('EmiSchedule.id')), 'count'],
      [literal('COALESCE(SUM(`EmiSchedule`.`bounce_charge`), 0)'), 'amount']
    ],
    where: assessedWhere,
    group: [literal(emiBucket)],
    order: [literal(`${emiBucket} ASC`)],
    raw: true
  });

  const collectedWhere = {
    status: COLLECTION_STATUS.POSTED,
    collectionDate: { [Op.between]: [window.from, window.to] },
    bounceAmount: { [Op.gt]: 0 }
  };
  if (loanIds) collectedWhere.loanId = { [Op.in]: loanIds };

  const collectionBucket = bucketExpression('`Collection`.`collection_date`', bucket);
  const collectedRows = await Collection.findAll({
    attributes: [
      [literal(collectionBucket), 'bucket'],
      [fn('COUNT', col('Collection.id')), 'count'],
      [literal('COALESCE(SUM(`Collection`.`bounce_amount`), 0)'), 'amount']
    ],
    where: collectedWhere,
    group: [literal(collectionBucket)],
    order: [literal(`${collectionBucket} ASC`)],
    raw: true
  });

  assertSeriesSize(Math.max(assessedRows.length, collectedRows.length), { what: 'bounce series' });

  const series = (rows) =>
    rows.map((row) => ({ label: isoDate(row.bucket), date: isoDate(row.bucket), count: Number(row.count), amount: money(row.amount) }));

  const assessed = series(assessedRows);
  const collected = series(collectedRows);
  const total = (points) => fromPaise(points.reduce((sum, point) => sum + toPaise(point.amount), 0n));

  return {
    charts: {
      bounceAssessedOverTime: {
        title: 'Bounce charges assessed',
        kind: 'series',
        note: 'Charges levied on instalments, by the period the instalment fell due. Not money received.',
        points: assessed
      },
      bounceCollectedOverTime: {
        title: 'Bounce actually collected',
        kind: 'series',
        note: 'Money received against bounce charges, by the period it was received. Never includes an unpaid charge.',
        points: collected
      },
      bounceAssessedVsCollected: {
        title: 'Assessed vs collected',
        kind: 'category',
        note: 'Two separate facts, shown side by side and never summed.',
        points: [
          { label: 'Assessed', count: assessed.reduce((sum, point) => sum + point.count, 0), amount: total(assessed) },
          { label: 'Collected', count: collected.reduce((sum, point) => sum + point.count, 0), amount: total(collected) }
        ]
      }
    },
    summary: {
      bounceAssessed: total(assessed),
      bounceCollected: total(collected),
      bounceCollectionCount: collected.reduce((sum, point) => sum + point.count, 0)
    }
  };
}

/* --------------------------------------------- demand vs collection (F) */

/**
 * Demand and money received, side by side, per period and per route.
 *
 * The two come from different tables measured on different dates and are never
 * added. A collection rate is reported only where both sides of it are real:
 * per bucket it is collected ÷ gross instalment demand of that same bucket,
 * and it is omitted (null, not zero) when the bucket has no demand, because a
 * rate over nothing is not 0% — it is undefined.
 */
async function demandVsCollectionAnalytics({ filters, scope, window, bucket, asOf }) {
  const demand = await demandAnalytics({ scope, window, bucket, asOf });
  const collections = await collectionAnalytics({ filters, scope, window, bucket });

  const byLabel = new Map();
  const touch = (label, date) => {
    if (!byLabel.has(label)) {
      byLabel.set(label, { label, date, count: 0, grossDemand: '0.00', netDemand: '0.00', collected: '0.00' });
    }
    return byLabel.get(label);
  };

  for (const point of demand.charts.demandOverTime.points) {
    const entry = touch(point.label, point.date);
    entry.grossDemand = point.gross;
    entry.netDemand = point.net;
    entry.count += point.count;
  }
  for (const point of collections.charts.collectionsOverTime.points) {
    const entry = touch(point.label, point.date);
    entry.collected = point.amount;
  }

  const points = [...byLabel.values()]
    .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    .map((entry) => {
      const grossPaise = toPaise(entry.grossDemand);
      return {
        ...entry,
        amount: entry.collected,
        // Undefined, not zero, when there was no demand to collect against.
        collectionRate: grossPaise > 0n ? Number((Number(toPaise(entry.collected)) * 100) / Number(grossPaise)).toFixed(2) : null
      };
    });

  assertSeriesSize(points.length, { what: 'demand vs collection series' });

  // Route-wise comparison: the same two groupings, aligned by route code.
  const routeMap = new Map();
  for (const point of demand.charts.demandByRoute.points) {
    routeMap.set(point.label, { label: point.label, routeName: point.routeName, count: point.count, netDemand: point.amount, collected: '0.00' });
  }
  for (const point of collections.charts.collectionsByRoute.points) {
    const entry = routeMap.get(point.label) ?? { label: point.label, routeName: point.routeName, count: 0, netDemand: '0.00', collected: '0.00' };
    entry.collected = point.amount;
    routeMap.set(point.label, entry);
  }
  const byRoute = [...routeMap.values()]
    .map((entry) => ({ ...entry, amount: entry.collected }))
    .sort((a, b) => a.label.localeCompare(b.label));

  assertCategorySize(byRoute.length, 'routes');

  return {
    charts: {
      demandVsCollected: {
        title: 'Demand vs collected',
        kind: 'series',
        note: 'Demand is what is owed and collected is what arrived. The two are never added together.',
        points,
        seriesKeys: [
          { key: 'grossDemand', label: 'Gross demand' },
          { key: 'netDemand', label: 'Net demand outstanding' },
          { key: 'collected', label: 'Collected' }
        ]
      },
      demandVsCollectedByRoute: {
        title: 'Demand and collection by route',
        kind: 'category',
        points: byRoute,
        seriesKeys: [
          { key: 'netDemand', label: 'Net demand outstanding' },
          { key: 'collected', label: 'Collected' }
        ]
      }
    },
    summary: {
      ...demand.summary,
      ...collections.summary
    }
  };
}

/* --------------------------------------------------------------- entry point */

const SECTION_HANDLERS = {
  [ANALYTICS_SECTIONS.LOANS]: loanAnalytics,
  [ANALYTICS_SECTIONS.DEMAND]: demandAnalytics,
  [ANALYTICS_SECTIONS.COLLECTIONS]: collectionAnalytics,
  [ANALYTICS_SECTIONS.EMIS]: emiAnalytics,
  [ANALYTICS_SECTIONS.BOUNCE]: bounceAnalytics,
  [ANALYTICS_SECTIONS.DEMAND_VS_COLLECTION]: demandVsCollectionAnalytics
};

/**
 * GET /api/admin/reports/analytics
 *
 * One section per request. The validator has already confirmed `section` and
 * `bucket` are values we recognise, so the lookup below cannot be steered
 * anywhere unexpected.
 */
async function analytics(filters = {}, actor) {
  const asOf = filters.date || today();
  const section = filters.section || ANALYTICS_SECTIONS.COLLECTIONS;
  const bucket = filters.bucket || ANALYTICS_BUCKETS.DAY;

  const handler = Object.prototype.hasOwnProperty.call(SECTION_HANDLERS, section) ? SECTION_HANDLERS[section] : null;
  if (!handler) throw ApiError.badRequest(`Unknown analytics section: ${section}`);

  const window = resolveWindow({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, asOf });

  // Refused before any query runs, so an unreadable request costs nothing.
  assertSeriesSize(bucketsInWindow(window.from, window.to, bucket), {
    what: 'date range',
    hint: 'Shorten the range, or group by week or month.'
  });

  const scope = await reportService.resolveScope(actor, filters);

  const { charts, summary } = await handler({ filters, scope, window, bucket, asOf });

  const pointCount = Object.values(charts).reduce((total, chart) => total + chart.points.length, 0);

  return {
    section,
    bucket,
    asOf,
    period: { from: window.from, to: window.to },
    // Echoed back so the page can state the context it is showing, and so the
    // export's Summary sheet records the filters that produced it.
    appliedFilters: {
      routeId: filters.routeId ?? null,
      collectorId: filters.collectorId ?? null,
      status: filters.status ?? null,
      loanType: filters.loanType ?? null,
      emiStatus: filters.emiStatus ?? null,
      ledgerType: filters.ledgerType ?? null
    },
    charts,
    summary: {
      section,
      bucket,
      asOf,
      periodFrom: window.from,
      periodTo: window.to,
      pointCount,
      ...summary
    },
    // Every chart point as flat rows, which is what an export writes. Built here
    // rather than in the controller so the file and the screen are the same data.
    rows: flattenForExport(charts)
  };
}

/** Every chart's points as one flat row list: which chart, which series, which point. */
function flattenForExport(charts) {
  const rows = [];

  for (const chart of Object.values(charts)) {
    const seriesKeys = chart.seriesKeys ?? null;

    for (const point of chart.points) {
      if (seriesKeys) {
        // A multi-series chart writes one row per series per point, so no figure
        // is lost to a single "amount" column.
        for (const series of seriesKeys) {
          rows.push({
            chart: chart.title,
            series: series.label,
            label: point.label,
            date: point.date ?? null,
            count: null,
            amount: point[series.key] ?? '0.00'
          });
        }
        // The point's own count, once, not repeated per series.
        if (point.count !== null && point.count !== undefined) {
          rows.push({ chart: chart.title, series: 'Count', label: point.label, date: point.date ?? null, count: point.count, amount: null });
        }
      } else {
        rows.push({
          chart: chart.title,
          series: chart.title,
          label: point.label,
          date: point.date ?? null,
          count: point.count ?? null,
          amount: point.amount ?? null
        });
      }
    }
  }

  return rows;
}

module.exports = {
  analytics,
  bucketExpression,
  resolveWindow,
  bucketsInWindow,
  flattenForExport,
  EMI_STATUS
};
