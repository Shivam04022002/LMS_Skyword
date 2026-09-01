'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { Loan, EmiSchedule, Collection, LoanRoute, Route, RouteCollector, User } = require('../models');
const ApiError = require('../utils/ApiError');
const routeService = require('./routeService');
const collectionAllocationService = require('./collectionAllocationService');
const demandService = require('./demandService');
const { toPaise, fromPaise } = require('../utils/money');
const { today } = require('../utils/dates');
const { EMI_STATUS } = require('../config/emis');
const { COLLECTION_STATUS } = require('../config/collections');
const { ASSIGNMENT_STATUS } = require('../config/routes');
const { DEFAULT_LIMIT, MAX_LIMIT, EXPORT_MAX_ROWS, EXPORT_SCOPE, BOUNCE_SCOPE } = require('../config/reports');

/**
 * Read-only reporting.
 *
 * Every figure is derived from the existing source-of-truth chain; nothing is
 * stored and no calculation is re-implemented. Displayed EMI values come from
 * the EmiSchedule model methods, demand comes from demandService, and money is
 * summed in integer paise via utils/money.
 */

/* ------------------------------------------------------------------ scoping */

/**
 * Resolves what the caller is allowed to see.
 *
 * A COLLECTOR is confined to the routes they are actively assigned to. Passing
 * someone else's routeId or collectorId is refused outright rather than quietly
 * returning an empty set, so a probing request cannot be used to infer whether
 * other data exists.
 */
async function resolveScope(actor, { routeId, collectorId } = {}) {
  const scoped = routeService.isScopedActor(actor);

  if (!scoped) {
    let routeIds = null;
    if (collectorId) {
      routeIds = await routeService.activeRouteIdsForCollector(Number(collectorId));
      if (routeId) routeIds = routeIds.includes(Number(routeId)) ? [Number(routeId)] : [];
    } else if (routeId) {
      routeIds = [Number(routeId)];
    }
    return { scoped: false, routeIds, selfUserId: null };
  }

  const own = await routeService.activeRouteIdsForCollector(actor.id);

  if (routeId && !own.includes(Number(routeId))) {
    throw ApiError.forbidden('You are not assigned to this route');
  }
  if (collectorId && Number(collectorId) !== Number(actor.id)) {
    throw ApiError.forbidden('You can only report on your own collections');
  }

  return { scoped: true, routeIds: routeId ? [Number(routeId)] : own, selfUserId: actor.id };
}

/** Loan ids currently assigned to the given routes. */
async function loanIdsForRoutes(routeIds) {
  if (!routeIds || routeIds.length === 0) return [];
  const rows = await LoanRoute.findAll({
    attributes: ['loanId'],
    where: { routeId: { [Op.in]: routeIds }, status: ASSIGNMENT_STATUS.ACTIVE },
    raw: true
  });
  return [...new Set(rows.map((row) => row.loanId))];
}

/** Current route (and its active collectors) for a set of loans, in two queries. */
async function routeContextForLoans(loanIds) {
  if (loanIds.length === 0) return { routeByLoan: new Map(), collectorsByRoute: {} };

  const assignments = await LoanRoute.findAll({
    where: { loanId: { [Op.in]: loanIds }, status: ASSIGNMENT_STATUS.ACTIVE },
    include: [{ association: 'Route', attributes: ['id', 'routeCode', 'name', 'status'] }]
  });
  const routeByLoan = new Map(assignments.map((a) => [a.loanId, a.Route]));

  const routeIds = [...new Set([...routeByLoan.values()].filter(Boolean).map((r) => r.id))];
  const collectorRows = routeIds.length
    ? await RouteCollector.findAll({
        where: { routeId: { [Op.in]: routeIds }, status: ASSIGNMENT_STATUS.ACTIVE },
        include: [{ association: 'Collector', attributes: ['id', 'name'] }]
      })
    : [];

  const collectorsByRoute = collectorRows.reduce((accumulator, row) => {
    (accumulator[row.routeId] = accumulator[row.routeId] || []).push({ id: row.Collector?.id, name: row.Collector?.name });
    return accumulator;
  }, {});

  return { routeByLoan, collectorsByRoute };
}

const applicantOf = (loan) =>
  (loan?.Parties ?? []).find((party) => party.partyRole === 'APPLICANT' && party.status === 'ACTIVE')?.Customer ?? null;

function paging({ page, limit, [EXPORT_SCOPE]: isExport = false }) {
  // A screen is capped at MAX_LIMIT. A download is not a screen: it must contain
  // every row the filters select, so it is capped at EXPORT_MAX_ROWS instead —
  // beyond which the controller refuses the export rather than trimming it.
  // Without this an export of more than MAX_LIMIT rows was silently truncated
  // while its Summary still reported the full total.
  const ceiling = isExport ? EXPORT_MAX_ROWS : MAX_LIMIT;
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(ceiling, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  return { currentPage, pageSize, offset: (currentPage - 1) * pageSize };
}

const pagination = (currentPage, pageSize, total) => ({
  page: currentPage,
  limit: pageSize,
  total,
  totalPages: Math.ceil(total / pageSize) || 0
});

/* -------------------------------------------------------------- loan report */

/** GET /api/admin/reports/loans */
async function loanReport(filters = {}, actor) {
  const { status, loanType, dateFrom, dateTo, search, page, limit } = filters;
  const scope = await resolveScope(actor, filters);
  const { currentPage, pageSize, offset } = paging({ page, limit, [EXPORT_SCOPE]: filters[EXPORT_SCOPE] });

  const where = {};
  if (status) where.status = status;
  if (loanType) where.loanType = loanType;
  if (dateFrom || dateTo) {
    where.startDate = {};
    if (dateFrom) where.startDate[Op.gte] = dateFrom;
    if (dateTo) where.startDate[Op.lte] = dateTo;
  }
  if (search && String(search).trim()) {
    where.loanNumber = { [Op.like]: `%${String(search).trim()}%` };
  }

  if (scope.routeIds !== null) {
    const loanIds = await loanIdsForRoutes(scope.routeIds);
    if (loanIds.length === 0) return emptyLoanReport(currentPage, pageSize);
    where.id = { [Op.in]: loanIds };
  }

  const { rows, count } = await Loan.findAndCountAll({
    where,
    include: [
      { association: 'Parties', include: [{ association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile'] }] },
      { association: 'CreatedBy', attributes: ['id', 'name'] }
    ],
    order: [['id', 'DESC']],
    limit: pageSize,
    offset,
    distinct: true
  });

  const pageLoanIds = rows.map((loan) => loan.id);

  // One aggregate for the page, not one query per loan.
  const collectedRows = pageLoanIds.length
    ? await EmiSchedule.findAll({
        attributes: ['loanId', [fn('SUM', col('amount_collected')), 'collected']],
        where: { loanId: { [Op.in]: pageLoanIds } },
        group: ['loanId'],
        raw: true
      })
    : [];
  const collectedByLoan = new Map(collectedRows.map((row) => [Number(row.loanId), toPaise(row.collected ?? '0')]));

  const { routeByLoan, collectorsByRoute } = await routeContextForLoans(pageLoanIds);

  const loans = rows.map((loan) => {
    const customer = applicantOf(loan);
    const route = routeByLoan.get(loan.id) ?? null;
    const collectedPaise = collectedByLoan.get(loan.id) ?? 0n;
    const outstandingPaise = toPaise(loan.totalRepayment) - collectedPaise;

    return {
      id: loan.id,
      loanNumber: loan.loanNumber,
      status: loan.status,
      loanAmount: loan.loanAmount,
      roi: loan.roi,
      roiBasis: loan.roiBasis,
      tenure: loan.tenure,
      loanType: loan.loanType,
      totalRepayment: loan.totalRepayment,
      emiAmount: loan.emiAmount,
      emiCount: loan.emiCount,
      collected: fromPaise(collectedPaise),
      outstanding: fromPaise(outstandingPaise > 0n ? outstandingPaise : 0n),
      startDate: loan.startDate,
      createdAt: loan.createdAt,
      customer: customer
        ? { id: customer.id, cifId: customer.cifId, fullName: customer.fullName, mobile: customer.mobile }
        : null,
      route: route ? { id: route.id, routeCode: route.routeCode, name: route.name } : null,
      collectors: route ? collectorsByRoute[route.id] ?? [] : [],
      collectorNames: route ? (collectorsByRoute[route.id] ?? []).map((c) => c.name).join('; ') : ''
    };
  });

  const summary = await loanReportSummary(where);

  return { loans, summary, pagination: pagination(currentPage, pageSize, count) };
}

/** Totals across the whole filtered set, not just the current page. */
async function loanReportSummary(where) {
  const [totals] = await Loan.findAll({
    attributes: [
      [fn('COUNT', col('id')), 'loanCount'],
      [fn('COALESCE', fn('SUM', col('loan_amount')), 0), 'loanAmount'],
      [fn('COALESCE', fn('SUM', col('total_repayment')), 0), 'totalRepayment']
    ],
    where,
    raw: true
  });

  // Ids only — cheap, and keeps the EMI aggregate bounded by loan count.
  const ids = await Loan.findAll({ attributes: ['id'], where, raw: true });
  const loanIds = ids.map((row) => row.id);

  const [collected] = loanIds.length
    ? await EmiSchedule.findAll({
        attributes: [[fn('COALESCE', fn('SUM', col('amount_collected')), 0), 'collected']],
        where: { loanId: { [Op.in]: loanIds } },
        raw: true
      })
    : [{ collected: '0' }];

  const totalRepaymentPaise = toPaise(String(totals.totalRepayment ?? '0'));
  const collectedPaise = toPaise(String(collected.collected ?? '0'));
  const outstandingPaise = totalRepaymentPaise - collectedPaise;

  return {
    loanCount: Number(totals.loanCount ?? 0),
    totalLoanAmount: fromPaise(toPaise(String(totals.loanAmount ?? '0'))),
    totalRepayment: fromPaise(totalRepaymentPaise),
    totalCollected: fromPaise(collectedPaise),
    totalOutstanding: fromPaise(outstandingPaise > 0n ? outstandingPaise : 0n)
  };
}

const emptyLoanReport = (page, limit) => ({
  loans: [],
  summary: { loanCount: 0, totalLoanAmount: '0.00', totalRepayment: '0.00', totalCollected: '0.00', totalOutstanding: '0.00' },
  pagination: pagination(page, limit, 0)
});

/* -------------------------------------------------------- collection report */

/**
 * GET /api/admin/reports/collections
 *
 * REVERSED collections stay visible but are excluded from the money totals —
 * the same rule the collection ledger applies, read from the same status field.
 */
async function collectionReport(filters = {}, actor) {
  const { dateFrom, dateTo, status, ledgerType, search, page, limit } = filters;
  const scope = await resolveScope(actor, filters);
  const { currentPage, pageSize, offset } = paging({ page, limit, [EXPORT_SCOPE]: filters[EXPORT_SCOPE] });

  const where = {};
  if (status) where.status = status;
  if (ledgerType) where.ledgerType = ledgerType;
  if (dateFrom || dateTo) {
    where.collectionDate = {};
    if (dateFrom) where.collectionDate[Op.gte] = dateFrom;
    if (dateTo) where.collectionDate[Op.lte] = dateTo;
  }
  if (search && String(search).trim()) {
    where.collectionNumber = { [Op.like]: `%${String(search).trim()}%` };
  }

  /*
   * Bounce Collection view: only collections that actually carry bounce money.
   *
   * Applied here, in SQL, so paging and the summary both see the restricted
   * set — the alternative, fetching every collection and dropping the zero-
   * bounce ones in the browser, would page wrongly and scale badly. Everything
   * else about the query, the row shape and the totals is untouched, which is
   * why this report needs no bounce calculation of its own.
   */
  if (filters[BOUNCE_SCOPE]) {
    where.bounceAmount = { [Op.gt]: 0 };
  }

  if (scope.routeIds !== null) {
    const loanIds = await loanIdsForRoutes(scope.routeIds);
    // A collector also keeps sight of collections they posted themselves, even
    // if the loan has since moved to another route.
    const clauses = [];
    if (loanIds.length > 0) clauses.push({ loanId: { [Op.in]: loanIds } });
    if (scope.selfUserId) clauses.push({ createdBy: scope.selfUserId });
    if (clauses.length === 0) return emptyCollectionReport(currentPage, pageSize);
    where[Op.and] = [...(where[Op.and] ?? []), { [Op.or]: clauses }];
  }

  const { rows, count } = await Collection.findAndCountAll({
    where,
    include: [
      { association: 'Loan', attributes: ['id', 'loanNumber', 'status'] },
      { association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile'] },
      { association: 'CreatedBy', attributes: ['id', 'name'] }
    ],
    order: [['collectionDate', 'DESC'], ['id', 'DESC']],
    limit: pageSize,
    offset,
    subQuery: false,
    distinct: true
  });

  const { routeByLoan } = await routeContextForLoans(rows.map((row) => row.loanId));

  // The principal / interest split of the rows on this page, read from the
  // allocation ledger. One query for the page, not one per collection. Bounce
  // is NOT in it: it is stored on the collection row itself, already in hand.
  const pageBreakdown = rows.length
    ? (await collectionAllocationService.allocationBreakdown({ id: { [Op.in]: rows.map((row) => row.id) } })).byCollection
    : new Map();

  const collections = rows.map((collection) => {
    const route = routeByLoan.get(collection.loanId) ?? null;
    const posted = collection.status === COLLECTION_STATUS.POSTED;
    const split = pageBreakdown.get(collection.id) ?? EMPTY_BREAKDOWN;

    return {
      id: collection.id,
      collectionNumber: collection.collectionNumber,
      collectionDate: collection.collectionDate,
      status: collection.status,
      amount: collection.amount,
      ledgerType: collection.ledgerType,
      paymentReference: collection.paymentReference,
      loan: collection.Loan ? { id: collection.Loan.id, loanNumber: collection.Loan.loanNumber, status: collection.Loan.status } : null,
      customer: collection.Customer
        ? { id: collection.Customer.id, cifId: collection.Customer.cifId, fullName: collection.Customer.fullName }
        : null,
      route: route ? { id: route.id, routeCode: route.routeCode, name: route.name } : null,
      createdBy: collection.CreatedBy?.name ?? null,
      // The split of THIS collection's own allocations. Shown for a reversed
      // collection too, exactly as its `amount` is — `countsTowardTotals` is
      // what says whether it counts, and the summary honours that.
      collectedPrincipal: split.collectedPrincipal,
      collectedInterest: split.collectedInterest,
      /*
       * The instalment half of this payment (principal + interest), and the
       * bounce half. They sum to `amount` exactly:
       *
       *     emiCollected + collectedBounce === amount
       *
       * `collectedBounce` is money the customer actually handed over against a
       * bounce charge, read from this collection's own `bounce_amount`. It is
       * NOT the bounce charge recorded on the instalments this payment reached
       * — an unpaid charge shows 0.00 here for as long as it stays unpaid.
       */
      emiCollected: split.emiCollected,
      collectedBounce: collection.bounceAmount,
      // Makes the POSTED/REVERSED rule explicit in the row itself.
      countsTowardTotals: posted
    };
  });

  const summary = await collectionReportSummary(where, { includeBounceDetail: Boolean(filters[BOUNCE_SCOPE]) });

  return { collections, summary, pagination: pagination(currentPage, pageSize, count) };
}

/**
 * GET /api/admin/reports/bounce-collections
 *
 * The Bounce Collection report: collections that actually carried bounce money.
 *
 * A thin view over `collectionReport`, deliberately — not a second query, not a
 * second set of totals, and not a second definition of what bounce is. It adds
 * exactly one thing: `bounce_amount > 0` in the WHERE clause. Every row field
 * and every summary figure is the one the collection report already computes
 * from `collections.bounce_amount`, so the two pages can never disagree, and
 * `emi_schedules.bounce_charge` is no more involved here than it is there.
 *
 * Scope, status, ledger, date and search filters all behave identically,
 * including a collector being confined to their own routes.
 */
async function bounceCollectionReport(filters = {}, actor) {
  return collectionReport({ ...filters, [BOUNCE_SCOPE]: true }, actor);
}

const EMPTY_BREAKDOWN = Object.freeze({ collectedPrincipal: '0.00', collectedInterest: '0.00', emiCollected: '0.00' });

/**
 * Totals split by status: only POSTED money counts.
 *
 * `includeBounceDetail` adds the reversed bounce figure the Bounce Collection
 * page shows as "excluded from totals". It is opt-in so the collection report
 * and the dashboard, which do not display it, pay nothing for it.
 */
async function collectionReportSummary(where, { includeBounceDetail = false } = {}) {
  const rows = await Collection.findAll({
    attributes: ['status', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('amount')), 0), 'amount']],
    where,
    group: ['status'],
    raw: true
  });

  const byStatus = rows.reduce((accumulator, row) => {
    accumulator[row.status] = { count: Number(row.count), amount: toPaise(String(row.amount ?? '0')) };
    return accumulator;
  }, {});

  const posted = byStatus[COLLECTION_STATUS.POSTED] ?? { count: 0, amount: 0n };
  const reversed = byStatus[COLLECTION_STATUS.REVERSED] ?? { count: 0, amount: 0n };

  // The breakdown of the same filtered set, restricted to POSTED by the same
  // rule that keeps reversed money out of netCollected. AND-ed rather than
  // spread, so an explicit status filter is honoured rather than overwritten:
  // filtering to REVERSED correctly yields a zero breakdown.
  const postedOnly = { [Op.and]: [where, { status: COLLECTION_STATUS.POSTED }] };
  const { totals } = await collectionAllocationService.allocationBreakdown(postedOnly);

  /*
   * BOUNCE COLLECTION for this filtered set — money actually received against
   * bounce charges, summed from the collections' own `bounce_amount` under the
   * same POSTED restriction as everything else here. Nothing about the
   * instalments' `bounce_charge` enters it, so a charge that has been assessed
   * but not paid contributes nothing.
   */
  const { bounceCollection, bounceCollectionCount } = await collectionAllocationService.bounceCollected(postedOnly);

  /*
   * Bounce on the REVERSED rows of the same filtered set. Reported so the page
   * can show what is deliberately NOT in the collected total; it is never added
   * to one.
   */
  const reversedBounce = includeBounceDetail
    ? (await collectionAllocationService.bounceCollected({ [Op.and]: [where, { status: COLLECTION_STATUS.REVERSED }] }))
        .bounceCollection
    : undefined;

  return {
    totalCount: posted.count + reversed.count,
    postedCount: posted.count,
    // The headline figure — reversed money is deliberately not included.
    postedAmount: fromPaise(posted.amount),
    reversedCount: reversed.count,
    reversedAmount: fromPaise(reversed.amount),
    netCollected: fromPaise(posted.amount),
    /*
     * netCollected split by what the money was applied to:
     *
     *     netCollected = emiCollected + collectedBounce
     *     emiCollected = collectedPrincipal + collectedInterest
     *
     * Principal and interest are apportioned from the allocation ledger, so
     * they add up to the allocated total exactly; bounce is the part of the
     * money that was never allocated to an instalment. Every rupee received is
     * in exactly one of the three, and none is counted twice.
     */
    emiCollected: totals.emiCollected,
    collectedPrincipal: totals.collectedPrincipal,
    collectedInterest: totals.collectedInterest,
    collectedBounce: bounceCollection,
    // How many of those collections carried any bounce at all.
    bounceCollectionCount,
    ...(includeBounceDetail ? { reversedBounce } : {})
  };
}

const emptyCollectionReport = (page, limit) => ({
  collections: [],
  summary: {
    totalCount: 0,
    postedCount: 0,
    postedAmount: '0.00',
    reversedCount: 0,
    reversedAmount: '0.00',
    netCollected: '0.00',
    emiCollected: '0.00',
    collectedPrincipal: '0.00',
    collectedInterest: '0.00',
    collectedBounce: '0.00',
    bounceCollectionCount: 0
  },
  pagination: pagination(page, limit, 0)
});

/* --------------------------------------------------------------- EMI report */

/**
 * SQL predicates that select instalments by derived status.
 *
 * Row *values* always come from the EmiSchedule model methods — this only
 * decides which rows the database returns, so paging stays correct on large
 * datasets instead of filtering a page in memory. The mapping mirrors
 * EmiSchedule.computeStatus exactly and an offline test asserts the two agree
 * for every combination, so they cannot drift apart silently.
 */
function emiStatusPredicate(status, asOf) {
  const notWaived = { status: { [Op.ne]: EMI_STATUS.WAIVED } };

  switch (status) {
    case EMI_STATUS.WAIVED:
      return { status: EMI_STATUS.WAIVED };
    case EMI_STATUS.PAID:
      return { [Op.and]: [notWaived, literal('`EmiSchedule`.`amount_collected` >= `EmiSchedule`.`emi_amount`')] };
    case EMI_STATUS.PARTIAL:
      return {
        [Op.and]: [
          notWaived,
          literal('`EmiSchedule`.`amount_collected` > 0'),
          literal('`EmiSchedule`.`amount_collected` < `EmiSchedule`.`emi_amount`')
        ]
      };
    case EMI_STATUS.OVERDUE:
      return { [Op.and]: [notWaived, literal('`EmiSchedule`.`amount_collected` = 0'), { emiDate: { [Op.lt]: asOf } }] };
    case EMI_STATUS.DUE:
      return { [Op.and]: [notWaived, literal('`EmiSchedule`.`amount_collected` = 0'), { emiDate: asOf }] };
    case EMI_STATUS.PENDING:
      return { [Op.and]: [notWaived, literal('`EmiSchedule`.`amount_collected` = 0'), { emiDate: { [Op.gt]: asOf } }] };
    default:
      return {};
  }
}

/** GET /api/admin/reports/emis */
async function emiReport(filters = {}, actor) {
  const { date, dateFrom, dateTo, status, loanId, minDpd, page, limit } = filters;
  const asOf = date || today();
  const scope = await resolveScope(actor, filters);
  const { currentPage, pageSize, offset } = paging({ page, limit, [EXPORT_SCOPE]: filters[EXPORT_SCOPE] });

  const where = {};
  if (loanId) where.loanId = Number(loanId);
  if (dateFrom || dateTo) {
    where.emiDate = {};
    if (dateFrom) where.emiDate[Op.gte] = dateFrom;
    if (dateTo) where.emiDate[Op.lte] = dateTo;
  }

  const conditions = [];
  if (status) conditions.push(emiStatusPredicate(status, asOf));

  // "At least N days past due" is expressible as a date comparison, so it stays
  // in SQL rather than filtering a fetched page.
  if (minDpd !== undefined && minDpd !== null && minDpd !== '') {
    const days = Number(minDpd);
    if (Number.isFinite(days) && days > 0) {
      const cutoff = require('../utils/dates').addDays(asOf, -days);
      conditions.push({ emiDate: { [Op.lte]: cutoff } });
      conditions.push(literal('`EmiSchedule`.`amount_collected` < `EmiSchedule`.`emi_amount`'));
      conditions.push({ status: { [Op.ne]: EMI_STATUS.WAIVED } });
    }
  }

  if (scope.routeIds !== null) {
    const loanIds = await loanIdsForRoutes(scope.routeIds);
    if (loanIds.length === 0) return emptyEmiReport(currentPage, pageSize, asOf);
    conditions.push({ loanId: { [Op.in]: loanIds } });
  }

  if (conditions.length > 0) where[Op.and] = conditions;

  const { rows, count } = await EmiSchedule.findAndCountAll({
    where,
    include: [
      {
        association: 'Loan',
        attributes: ['id', 'loanNumber', 'status', 'loanType'],
        include: [{ association: 'Parties', include: [{ association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile'] }] }]
      }
    ],
    order: [['emiDate', 'ASC'], ['loanId', 'ASC'], ['emiNumber', 'ASC']],
    limit: pageSize,
    offset,
    distinct: true,
    subQuery: false
  });

  const { routeByLoan, collectorsByRoute } = await routeContextForLoans(rows.map((row) => row.loanId));

  const emis = rows.map((emi) => {
    const customer = applicantOf(emi.Loan);
    const route = routeByLoan.get(emi.loanId) ?? null;

    return {
      id: emi.id,
      emiNumber: emi.emiNumber,
      emiDate: emi.emiDate,
      emiAmount: emi.emiAmount,
      principal: emi.principal,
      interest: emi.interest,
      // Manually recorded fee, reported beside the instalment and part of none
      // of the totals below — exactly as the schedule screen shows it.
      bounceCharge: emi.bounceCharge,
      amountCollected: emi.amountCollected,
      // Derived by the Phase 6 model — never recomputed here.
      outstanding: emi.outstanding(),
      dpd: emi.computeDpd(asOf),
      status: emi.computeStatus(asOf),
      loan: emi.Loan ? { id: emi.Loan.id, loanNumber: emi.Loan.loanNumber, status: emi.Loan.status } : null,
      customer: customer ? { id: customer.id, cifId: customer.cifId, fullName: customer.fullName } : null,
      route: route ? { id: route.id, routeCode: route.routeCode, name: route.name } : null,
      collectors: route ? collectorsByRoute[route.id] ?? [] : [],
      collectorNames: route ? (collectorsByRoute[route.id] ?? []).map((c) => c.name).join('; ') : ''
    };
  });

  const [totals] = await EmiSchedule.findAll({
    attributes: [
      [fn('COUNT', col('id')), 'emiCount'],
      [fn('COALESCE', fn('SUM', col('emi_amount')), 0), 'emiAmount'],
      [fn('COALESCE', fn('SUM', col('principal')), 0), 'principal'],
      [fn('COALESCE', fn('SUM', col('interest')), 0), 'interest'],
      [fn('COALESCE', fn('SUM', col('amount_collected')), 0), 'collected']
    ],
    where,
    raw: true
  });

  const emiTotalPaise = toPaise(String(totals.emiAmount ?? '0'));
  const collectedPaise = toPaise(String(totals.collected ?? '0'));
  const outstandingPaise = emiTotalPaise - collectedPaise;

  return {
    asOf,
    emis,
    summary: {
      asOf,
      emiCount: Number(totals.emiCount ?? 0),
      totalEmiAmount: fromPaise(emiTotalPaise),
      totalPrincipal: fromPaise(toPaise(String(totals.principal ?? '0'))),
      totalInterest: fromPaise(toPaise(String(totals.interest ?? '0'))),
      totalCollected: fromPaise(collectedPaise),
      totalOutstanding: fromPaise(outstandingPaise > 0n ? outstandingPaise : 0n)
    },
    pagination: pagination(currentPage, pageSize, count)
  };
}

const emptyEmiReport = (page, limit, asOf) => ({
  asOf,
  emis: [],
  summary: { asOf, emiCount: 0, totalEmiAmount: '0.00', totalPrincipal: '0.00', totalInterest: '0.00', totalCollected: '0.00', totalOutstanding: '0.00' },
  pagination: pagination(page, limit, 0)
});

/* ------------------------------------------- demand vs collection report */

/**
 * GET /api/admin/reports/demand-collections
 *
 * Demand and money received are shown side by side and never conflated:
 *   grossDemand            — instalment value that is demandable on the date
 *   collectedAgainstDemand — what has already been paid against those instalments
 *   netDemand              — what is still owed on them  (gross − collected)
 *   collectedInPeriod      — POSTED collections dated in the period, whatever
 *                            instalment they were applied to; the FULL amount
 *                            received, so it includes any bounce component
 *   emiCollectedInPeriod   — the instalment half of that money
 *   bounceCollectedInPeriod— the bounce half: what was actually received
 *                            against bounce charges. Never compared against
 *                            demand, because demand is instalment value and a
 *                            bounce charge is not part of an instalment.
 *
 * Demand rows come from demandService — the Phase 8 calculation is reused whole,
 * not re-derived.
 */
async function demandCollectionReport(filters = {}, actor) {
  const { date, dateFrom, dateTo, routeId, collectorId } = filters;
  const asOf = date || today();
  const scope = await resolveScope(actor, { routeId, collectorId });

  const periodFrom = dateFrom || asOf;
  const periodTo = dateTo || asOf;

  // One demand call, grouped in memory — avoids a query per route.
  const demand = await demandService.getDemand({ date: asOf, routeId, collectorId, limit: 500 }, actor);

  const groups = new Map();
  const keyFor = (route) => (route ? `route:${route.id}` : 'unrouted');

  for (const row of demand.demand) {
    const key = keyFor(row.route);
    if (!groups.has(key)) {
      groups.set(key, {
        route: row.route ? { id: row.route.id, routeCode: row.route.routeCode, name: row.route.name } : null,
        collectors: row.collectors ?? [],
        demandEmiCount: 0,
        grossPaise: 0n,
        collectedAgainstPaise: 0n,
        netPaise: 0n
      });
    }
    const group = groups.get(key);
    group.demandEmiCount += 1;
    group.grossPaise += toPaise(row.emiAmount);
    group.collectedAgainstPaise += toPaise(row.amountCollected ?? '0');
    group.netPaise += toPaise(row.demandAmount);
  }

  // Money actually posted in the period, per route.
  const routeIdsInScope = scope.routeIds;
  const collectionWhere = { status: COLLECTION_STATUS.POSTED, collectionDate: { [Op.between]: [periodFrom, periodTo] } };

  let loanIdFilter = null;
  if (routeIdsInScope !== null) {
    loanIdFilter = await loanIdsForRoutes(routeIdsInScope);
    if (loanIdFilter.length === 0) loanIdFilter = [0];
    collectionWhere.loanId = { [Op.in]: loanIdFilter };
  }

  const periodCollections = await Collection.findAll({
    attributes: ['id', 'loanId', 'amount', 'bounceAmount'],
    where: collectionWhere,
    raw: true
  });

  const { routeByLoan } = await routeContextForLoans([...new Set(periodCollections.map((c) => c.loanId))]);

  for (const collection of periodCollections) {
    const route = routeByLoan.get(collection.loanId) ?? null;
    const key = keyFor(route);
    if (!groups.has(key)) {
      groups.set(key, {
        route: route ? { id: route.id, routeCode: route.routeCode, name: route.name } : null,
        collectors: [],
        demandEmiCount: 0,
        grossPaise: 0n,
        collectedAgainstPaise: 0n,
        netPaise: 0n
      });
    }
    const group = groups.get(key);
    const bouncePaise = toPaise(collection.bounceAmount ?? '0');
    group.collectionCount = (group.collectionCount ?? 0) + 1;
    group.collectedInPeriodPaise = (group.collectedInPeriodPaise ?? 0n) + toPaise(collection.amount);
    group.bounceInPeriodPaise = (group.bounceInPeriodPaise ?? 0n) + bouncePaise;
    group.emiInPeriodPaise = (group.emiInPeriodPaise ?? 0n) + (toPaise(collection.amount) - bouncePaise);
  }

  const rows = [...groups.values()].map((group) => ({
    route: group.route,
    collectors: group.collectors,
    collectorNames: (group.collectors ?? []).map((c) => c.name).join('; '),
    demandEmiCount: group.demandEmiCount,
    grossDemand: fromPaise(group.grossPaise),
    collectedAgainstDemand: fromPaise(group.collectedAgainstPaise),
    netDemand: fromPaise(group.netPaise),
    collectionCount: group.collectionCount ?? 0,
    collectedInPeriod: fromPaise(group.collectedInPeriodPaise ?? 0n),
    // The two halves of collectedInPeriod, never added to it.
    emiCollectedInPeriod: fromPaise(group.emiInPeriodPaise ?? 0n),
    bounceCollectedInPeriod: fromPaise(group.bounceInPeriodPaise ?? 0n)
  }));

  rows.sort((a, b) => (a.route?.routeCode ?? 'zzz').localeCompare(b.route?.routeCode ?? 'zzz'));

  const sumField = (field) => fromPaise(rows.reduce((total, row) => total + toPaise(row[field]), 0n));

  return {
    asOf,
    period: { from: periodFrom, to: periodTo },
    rows,
    summary: {
      asOf,
      routeCount: rows.length,
      demandEmiCount: rows.reduce((total, row) => total + row.demandEmiCount, 0),
      grossDemand: sumField('grossDemand'),
      collectedAgainstDemand: sumField('collectedAgainstDemand'),
      netDemand: sumField('netDemand'),
      collectionCount: rows.reduce((total, row) => total + row.collectionCount, 0),
      collectedInPeriod: sumField('collectedInPeriod'),
      emiCollectedInPeriod: sumField('emiCollectedInPeriod'),
      bounceCollectedInPeriod: sumField('bounceCollectedInPeriod')
    }
  };
}

module.exports = {
  loanReport,
  collectionReport,
  bounceCollectionReport,
  emiReport,
  demandCollectionReport,
  resolveScope,
  loanIdsForRoutes,
  emiStatusPredicate,
  paging
};
