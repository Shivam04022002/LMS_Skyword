'use strict';

const { Op } = require('sequelize');
const { EmiSchedule, Loan, LoanRoute, Route, RouteCollector } = require('../models');
const ApiError = require('../utils/ApiError');
const routeService = require('./routeService');
const { toPaise, fromPaise } = require('../utils/money');
const { today, differenceInDays } = require('../utils/dates');
const { EMI_STATUS } = require('../config/emis');
const { ASSIGNMENT_STATUS, ROUTE_STATUS, DEMAND_BUCKET } = require('../config/routes');
const { LOAN_STATUS } = require('../config/loans');

/**
 * Collection demand.
 *
 * Demand is entirely DERIVED — there is no demand table and no second ledger.
 * It reads instalments and reuses the existing model logic:
 *   - `emi.outstanding()` for the amount still owed
 *   - `emi.computeStatus(asOf)` / `emi.computeDpd(asOf)` for state and lateness
 *
 * Those read `amount_collected`, which the collection service rebuilds from the
 * allocation ledger on every posting and reversal. A reversed collection is
 * therefore already excluded, with no payment logic restated here.
 *
 * Demand never writes: it touches no collection, allocation or instalment row.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Instalments that can still be demanded. PAID and WAIVED owe nothing. */
const DEMANDABLE_STATUSES = [EMI_STATUS.PENDING, EMI_STATUS.DUE, EMI_STATUS.PARTIAL, EMI_STATUS.OVERDUE];

/**
 * Which bucket an instalment falls into on the requested business date.
 *   due date before it  -> OVERDUE
 *   due date on it      -> DUE_TODAY
 *   due date after it   -> UPCOMING
 */
function bucketFor(emiDate, asOf) {
  const daysLate = differenceInDays(emiDate, asOf);
  if (daysLate > 0) return DEMAND_BUCKET.OVERDUE;
  if (daysLate === 0) return DEMAND_BUCKET.DUE_TODAY;
  return DEMAND_BUCKET.UPCOMING;
}

/**
 * GET /api/admin/demand
 *
 * By default returns what is collectable on `date` — overdue plus due today.
 * Future instalments are excluded unless `includeUpcoming=true` is asked for,
 * because they are not yet demandable.
 */
async function getDemand(
  { date, routeId, collectorId, loanId, customerId, bucket, includeUpcoming = false, page = 1, limit = DEFAULT_LIMIT } = {},
  actor
) {
  const asOf = date || today();
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));

  // --- resolve which routes are in scope -------------------------------------
  let routeScope = null; // null = every route (and unrouted loans)

  if (routeService.isScopedActor(actor)) {
    // A collector sees demand for their own routes only.
    routeScope = await routeService.activeRouteIdsForCollector(actor.id);
    if (routeId && !routeScope.includes(Number(routeId))) {
      throw ApiError.forbidden('You are not assigned to this route');
    }
    if (routeId) routeScope = [Number(routeId)];
  } else if (collectorId) {
    routeScope = await routeService.activeRouteIdsForCollector(Number(collectorId));
    if (routeId) {
      routeScope = routeScope.includes(Number(routeId)) ? [Number(routeId)] : [];
    }
  } else if (routeId) {
    routeScope = [Number(routeId)];
  }

  // --- resolve which loans are in scope --------------------------------------
  const loanWhere = { status: LOAN_STATUS.ACTIVE };
  if (loanId) loanWhere.id = Number(loanId);

  let loanIdsFromRoutes = null;
  if (routeScope !== null) {
    if (routeScope.length === 0) {
      return emptyResult(asOf, currentPage, pageSize);
    }
    const assignments = await LoanRoute.findAll({
      attributes: ['loanId'],
      where: { routeId: { [Op.in]: routeScope }, status: ASSIGNMENT_STATUS.ACTIVE },
      raw: true
    });
    loanIdsFromRoutes = [...new Set(assignments.map((a) => a.loanId))];
    if (loanIdsFromRoutes.length === 0) {
      return emptyResult(asOf, currentPage, pageSize);
    }
    loanWhere.id = loanId ? Number(loanId) : { [Op.in]: loanIdsFromRoutes };
  }

  // Only ACTIVE loans generate demand: a draft has no schedule, and a closed or
  // cancelled loan is not collectable.
  const loans = await Loan.findAll({
    where: loanWhere,
    include: [
      {
        association: 'Parties',
        include: [{ association: 'Customer', attributes: ['id', 'cifId', 'fullName', 'mobile'] }]
      }
    ]
  });

  const filteredLoans = customerId
    ? loans.filter((loan) =>
        (loan.Parties ?? []).some((party) => Number(party.customerId) === Number(customerId) && party.status === 'ACTIVE')
      )
    : loans;

  if (filteredLoans.length === 0) {
    return emptyResult(asOf, currentPage, pageSize);
  }

  const loanById = new Map(filteredLoans.map((loan) => [loan.id, loan]));

  // --- current route for each loan (for display) ------------------------------
  const routeAssignments = await LoanRoute.findAll({
    where: { loanId: { [Op.in]: [...loanById.keys()] }, status: ASSIGNMENT_STATUS.ACTIVE },
    include: [{ association: 'Route', attributes: ['id', 'routeCode', 'name', 'status'] }]
  });
  const routeByLoan = new Map(routeAssignments.map((a) => [a.loanId, a.Route]));

  // --- collectors per route (for display) -------------------------------------
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

  // --- instalments -------------------------------------------------------------
  const emiWhere = { loanId: { [Op.in]: [...loanById.keys()] } };
  if (!includeUpcoming) {
    // Only what is already demandable on the business date.
    emiWhere.emiDate = { [Op.lte]: asOf };
  }

  const emis = await EmiSchedule.findAll({ where: emiWhere, order: [['emiDate', 'ASC'], ['loanId', 'ASC'], ['emiNumber', 'ASC']] });

  const rows = [];
  for (const emi of emis) {
    const status = emi.computeStatus(asOf);

    // Fully paid and waived instalments owe nothing and are never demand.
    if (!DEMANDABLE_STATUSES.includes(status)) continue;

    const outstanding = emi.outstanding();
    if (toPaise(outstanding) <= 0n) continue;

    const emiBucket = bucketFor(emi.emiDate, asOf);
    if (bucket && emiBucket !== bucket) continue;

    const loan = loanById.get(emi.loanId);
    const applicant = (loan?.Parties ?? []).find((party) => party.partyRole === 'APPLICANT' && party.status === 'ACTIVE');
    const route = routeByLoan.get(emi.loanId) ?? null;

    rows.push({
      emiId: emi.id,
      emiNumber: emi.emiNumber,
      emiDate: emi.emiDate,
      emiAmount: emi.emiAmount,
      amountCollected: emi.amountCollected,
      // The demandable figure: instalment less valid posted allocations.
      demandAmount: outstanding,
      status,
      dpd: emi.computeDpd(asOf),
      bucket: emiBucket,
      loan: loan ? { id: loan.id, loanNumber: loan.loanNumber, loanType: loan.loanType, status: loan.status } : null,
      customer: applicant?.Customer
        ? {
            id: applicant.Customer.id,
            cifId: applicant.Customer.cifId,
            fullName: applicant.Customer.fullName,
            mobile: applicant.Customer.mobile
          }
        : null,
      route: route ? { id: route.id, routeCode: route.routeCode, name: route.name } : null,
      collectors: route ? collectorsByRoute[route.id] ?? [] : []
    });
  }

  const summary = summarise(rows, asOf);
  const offset = (currentPage - 1) * pageSize;

  return {
    date: asOf,
    demand: rows.slice(offset, offset + pageSize),
    summary,
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: rows.length,
      totalPages: Math.ceil(rows.length / pageSize) || 0
    }
  };
}

/** Totals over the demand rows, in exact integer paise. */
function summarise(rows, asOf) {
  const sumOf = (filtered) => fromPaise(filtered.reduce((total, row) => total + toPaise(row.demandAmount), 0n));

  const overdue = rows.filter((row) => row.bucket === DEMAND_BUCKET.OVERDUE);
  const dueToday = rows.filter((row) => row.bucket === DEMAND_BUCKET.DUE_TODAY);
  const upcoming = rows.filter((row) => row.bucket === DEMAND_BUCKET.UPCOMING);

  return {
    asOf,
    emiCount: rows.length,
    totalDemand: sumOf(rows),
    overdueCount: overdue.length,
    overdueAmount: sumOf(overdue),
    dueTodayCount: dueToday.length,
    dueTodayAmount: sumOf(dueToday),
    upcomingCount: upcoming.length,
    upcomingAmount: sumOf(upcoming),
    partialCount: rows.filter((row) => row.status === EMI_STATUS.PARTIAL).length,
    loanCount: new Set(rows.map((row) => row.loan?.id).filter(Boolean)).size,
    maxDpd: rows.reduce((highest, row) => Math.max(highest, row.dpd), 0)
  };
}

function emptyResult(asOf, page, limit) {
  return {
    date: asOf,
    demand: [],
    summary: summarise([], asOf),
    pagination: { page, limit, total: 0, totalPages: 0 }
  };
}

/** Route-level roll-up for planning a day's collection. */
async function getRouteDemandSummary({ date, routeId } = {}, actor) {
  const asOf = date || today();

  const routeWhere = { status: ROUTE_STATUS.ACTIVE };
  if (routeId) routeWhere.id = Number(routeId);

  if (routeService.isScopedActor(actor)) {
    const allowed = await routeService.activeRouteIdsForCollector(actor.id);
    routeWhere.id = routeId && allowed.includes(Number(routeId)) ? Number(routeId) : { [Op.in]: allowed.length ? allowed : [0] };
  }

  const routes = await Route.findAll({ where: routeWhere, order: [['routeCode', 'ASC']] });

  const summaries = [];
  for (const route of routes) {
    const result = await getDemand({ date: asOf, routeId: route.id, limit: MAX_LIMIT }, actor);
    summaries.push({
      route: { id: route.id, routeCode: route.routeCode, name: route.name, status: route.status },
      ...result.summary
    });
  }

  return { date: asOf, routes: summaries };
}

module.exports = { getDemand, getRouteDemandSummary, bucketFor, summarise, DEMANDABLE_STATUSES };
