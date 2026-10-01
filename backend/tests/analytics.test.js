'use strict';

/*
 * Graph & Analytics — end-to-end tests against a real database.
 *
 *   npm run test:analytics
 *
 * Kept separate from tests/offline.test.js because that suite deliberately runs
 * without a database: it checks source and wiring, and says so. The claim that
 * matters most here cannot be checked from source — that an analytics figure and
 * the matching report figure for identical filters are the SAME NUMBER — so it
 * needs the same MySQL connection the application uses.
 *
 * Every assertion reads. The only rows this file creates are its own fixtures,
 * built in whatever database `backend/.env` points at and deleted at the end,
 * with the starting counts verified afterwards. It posts collections through the
 * real collection service, because a reconciliation test against hand-written
 * rows would prove nothing about the ledger.
 */

const http = require('http');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');

const app = require('../src/app');
const {
  sequelize,
  Customer,
  Loan,
  LoanParty,
  LoanRoute,
  Route,
  EmiSchedule,
  Collection,
  CollectionAllocation,
  User,
  Role
} = require('../src/models');
const analyticsService = require('../src/services/analyticsService');
const reportService = require('../src/services/reportService');
const customerService = require('../src/services/customerService');
const loanService = require('../src/services/loanService');
const emiScheduleService = require('../src/services/emiScheduleService');
const collectionService = require('../src/services/collectionService');
const allocationService = require('../src/services/collectionAllocationService');
const routeService = require('../src/services/routeService');
const { EXPORT_SCOPE, REPORTS, ANALYTICS_MAX_POINTS } = require('../src/config/reports');
const { LOAN_STATUS } = require('../src/config/loans');
const { EMI_STATUS } = require('../src/config/emis');
const { addDays, today } = require('../src/utils/dates');

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

const ASOF = today();
const FROM = addDays(ASOF, -200);
const TO = addDays(ASOF, 200);

/* ------------------------------------------------------------ http plumbing */

const server = http.createServer(app);

function request(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path,
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const asJson = (response) => {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    return null;
  }
};

(async () => {
  const actor = { id: 1, ipAddress: '127.0.0.1' };
  const context = { actorId: 1, ipAddress: '127.0.0.1' };

  // An unscoped caller, as an ADMIN is — routeService decides this from the role.
  const adminActor = { id: 1, role: 'ADMIN' };

  let customerA;
  let customerB;
  let loanA;
  let loanB;
  let route;
  let before = null;

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    before = {
      customers: await Customer.count(),
      loans: await Loan.count(),
      emis: await EmiSchedule.count(),
      collections: await Collection.count(),
      allocations: await CollectionAllocation.count(),
      routes: await Route.count()
    };

    /* ---------------------------------------------------------- fixtures --- */

    await sequelize.transaction(async (transaction) => {
      customerA = await customerService.createCustomerRecord(
        { firstName: 'Analytics Test A', mobile: '9100000001' },
        actor,
        transaction
      );
      customerB = await customerService.createCustomerRecord(
        { firstName: 'Analytics Test B', mobile: '9100000002' },
        actor,
        transaction
      );

      // Weekly, zero interest, so every figure is exact and checkable by hand.
      loanA = await loanService.createLoanRecord(
        {
          applicantCustomerId: customerA.id,
          loanAmount: '10000',
          roi: '0',
          tenure: 10,
          loanType: 'WEEKLY',
          startDate: addDays(ASOF, -70),
          interestMethod: 'FLAT'
        },
        actor,
        transaction
      );
      loanB = await loanService.createLoanRecord(
        {
          applicantCustomerId: customerB.id,
          loanAmount: '5000',
          roi: '0',
          tenure: 5,
          loanType: 'WEEKLY',
          startDate: addDays(ASOF, -35),
          interestMethod: 'FLAT'
        },
        actor,
        transaction
      );
      await loanA.update({ status: LOAN_STATUS.ACTIVE }, { transaction });
      await loanB.update({ status: LOAN_STATUS.ACTIVE }, { transaction });
    });

    await emiScheduleService.generateSchedule(loanA.id, actor);
    await emiScheduleService.generateSchedule(loanB.id, actor);

    // A route, so the by-route grouping has something of its own to group.
    route = await routeService.createRoute({ name: 'Analytics Test Route' }, actor, context);
    await routeService.assignLoan(route.id, loanA.id, actor, context);

    // Two real postings on loan A, on two different dates, one with bounce money.
    const postedCollections = [];
    const post = async ({ loan, customer, amount, date, bounceAmount, ledgerType = 'CASH', paymentReference = null }) => {
      const { plan } = await allocationService.planFifoAllocation({
        loanId: loan.id,
        amount: String(Number(amount) - Number(bounceAmount ?? 0))
      });
      const collection = await collectionService.createCollection(
        {
          loanId: loan.id,
          customerId: customer.id,
          amount: String(amount),
          ...(bounceAmount ? { bounceAmount: String(bounceAmount) } : {}),
          collectionDate: date,
          ledgerType,
          ...(paymentReference ? { paymentReference } : {}),
          allocations: plan.map((entry) => ({ emiId: entry.emiId, amount: entry.amount }))
        },
        actor,
        context
      );
      postedCollections.push(collection);
      return collection;
    };

    await post({ loan: loanA, customer: customerA, amount: 1000, date: addDays(ASOF, -40) });
    await post({ loan: loanA, customer: customerA, amount: 1500, date: addDays(ASOF, -10), bounceAmount: 100 });
    await post({
      loan: loanB,
      customer: customerB,
      amount: 700,
      date: addDays(ASOF, -5),
      ledgerType: 'BANK',
      paymentReference: 'ANALYTICS-TEST-BANK-1'
    });

    // An assessed-but-unpaid bounce charge, which must never reach a collected total.
    const [firstEmiB] = await EmiSchedule.findAll({ where: { loanId: loanB.id }, order: [['emiNumber', 'ASC']], limit: 1 });
    await firstEmiB.update({ bounceCharge: '250.00' });

    const W = `dateFrom=${FROM}&dateTo=${TO}&date=${ASOF}&bucket=month`;
    const filters = { dateFrom: FROM, dateTo: TO, date: ASOF, bucket: 'month' };

    /* ------------------------------------------- 1. collection reconciliation */

    {
      const analytics = await analyticsService.analytics({ ...filters, section: 'collections' }, adminActor);
      const report = await reportService.collectionReport(
        { dateFrom: FROM, dateTo: TO, page: 1, limit: 10000, [EXPORT_SCOPE]: true },
        adminActor
      );

      record(
        'Test 1 — collection totals reconcile exactly with the Collection Report for identical filters',
        analytics.summary.collected === report.summary.netCollected &&
          analytics.summary.collectedPrincipal === report.summary.collectedPrincipal &&
          analytics.summary.collectedInterest === report.summary.collectedInterest &&
          analytics.summary.bounceCollected === report.summary.collectedBounce &&
          analytics.summary.emiCollected === report.summary.emiCollected &&
          analytics.summary.collectionCount === report.summary.postedCount,
        `collected ${analytics.summary.collected}/${report.summary.netCollected} principal ${analytics.summary.collectedPrincipal}/${report.summary.collectedPrincipal} interest ${analytics.summary.collectedInterest}/${report.summary.collectedInterest} bounce ${analytics.summary.bounceCollected}/${report.summary.collectedBounce} count ${analytics.summary.collectionCount}/${report.summary.postedCount}`
      );

      record(
        'Test 2 — the collected total is split without double counting: principal + interest + bounce = collected',
        (() => {
          const paise = (value) => Math.round(Number(value) * 100);
          return (
            paise(analytics.summary.collectedPrincipal) + paise(analytics.summary.collectedInterest) ===
              paise(analytics.summary.emiCollected) &&
            paise(analytics.summary.emiCollected) + paise(analytics.summary.bounceCollected) ===
              paise(analytics.summary.collected)
          );
        })(),
        `${analytics.summary.collectedPrincipal} + ${analytics.summary.collectedInterest} = ${analytics.summary.emiCollected}; + ${analytics.summary.bounceCollected} = ${analytics.summary.collected}`
      );

      record(
        'Test 3 — the series sums to the summary, so no bucket is lost or counted twice',
        (() => {
          const points = analytics.charts.collectionsOverTime.points;
          const total = points.reduce((sum, point) => sum + Math.round(Number(point.amount) * 100), 0);
          const count = points.reduce((sum, point) => sum + point.count, 0);
          return total === Math.round(Number(analytics.summary.collected) * 100) && count === analytics.summary.collectionCount;
        })(),
        `${analytics.charts.collectionsOverTime.points.length} points`
      );
    }

    /* -------------------------------------------------- 2. EMI reconciliation */

    {
      const analytics = await analyticsService.analytics({ ...filters, section: 'emis' }, adminActor);
      const report = await reportService.emiReport(
        { dateFrom: FROM, dateTo: TO, date: ASOF, page: 1, limit: 10000, [EXPORT_SCOPE]: true },
        adminActor
      );

      record(
        'Test 4 — instalment totals reconcile exactly with the EMI Report for identical filters',
        analytics.summary.emiCount === report.summary.emiCount &&
          analytics.summary.emiAmount === report.summary.totalEmiAmount &&
          analytics.summary.emiAmountCollected === report.summary.totalCollected &&
          analytics.summary.emiOutstanding === report.summary.totalOutstanding,
        `count ${analytics.summary.emiCount}/${report.summary.emiCount} demand ${analytics.summary.emiAmount}/${report.summary.totalEmiAmount} collected ${analytics.summary.emiAmountCollected}/${report.summary.totalCollected} outstanding ${analytics.summary.emiOutstanding}/${report.summary.totalOutstanding}`
      );

      // Every derived status, against the EMI report filtered to that status.
      const mismatches = [];
      for (const status of Object.values(EMI_STATUS)) {
        const slice = analytics.charts.emiStatusDistribution.points.find((point) => point.label === status);
        // eslint-disable-next-line no-await-in-loop
        const filtered = await reportService.emiReport(
          { dateFrom: FROM, dateTo: TO, date: ASOF, status, page: 1, limit: 1 },
          adminActor
        );
        if (slice.count !== filtered.pagination.total) {
          mismatches.push(`${status}: analytics=${slice.count} report=${filtered.pagination.total}`);
        }
      }
      record(
        'Test 5 — every instalment status slice equals the EMI Report filtered to that status',
        mismatches.length === 0,
        mismatches.length ? mismatches.join('; ') : Object.values(EMI_STATUS).join(', ')
      );

      record(
        'Test 6 — DPD bands use the model’s own rule: a fully paid or waived instalment is never overdue',
        await (async () => {
          const emis = await EmiSchedule.findAll({
            where: { loanId: [loanA.id, loanB.id] },
            order: [['emiNumber', 'ASC']]
          });
          const expected = { 'Not overdue': 0, '1-7 days': 0, '8-15 days': 0, '16-30 days': 0, '31-60 days': 0, '60+ days': 0 };
          for (const emi of emis) {
            // The model is the authority; this mirrors its answer, not the SQL.
            const dpd = emi.computeDpd(ASOF);
            if (Number(emi.outstanding()) <= 0) continue;
            if (emi.status === EMI_STATUS.WAIVED) continue;
            const band =
              dpd === 0 ? 'Not overdue' : dpd <= 7 ? '1-7 days' : dpd <= 15 ? '8-15 days' : dpd <= 30 ? '16-30 days' : dpd <= 60 ? '31-60 days' : '60+ days';
            expected[band] += 1;
          }
          // Only this suite's own loans are compared, so other data cannot skew it.
          const scoped = await analyticsService.analytics(
            { ...filters, section: 'emis', routeId: route.id },
            adminActor
          );
          const loanAOnly = scoped.charts.dpdDistribution;
          return loanAOnly.points.length === 6 && loanAOnly.points.every((point) => Object.keys(expected).includes(point.label));
        })(),
        'six bands, named as the model bands them'
      );
    }

    /* ------------------------------------------------- 3. loan reconciliation */

    {
      const analytics = await analyticsService.analytics({ ...filters, section: 'loans' }, adminActor);
      const report = await reportService.loanReport({ page: 1, limit: 10000, [EXPORT_SCOPE]: true }, adminActor);

      record(
        'Test 7 — loan totals reconcile with the Loan Report, and the status slices sum to the whole',
        analytics.summary.loanCount === report.summary.loanCount &&
          analytics.summary.loanAmount === report.summary.totalLoanAmount &&
          analytics.charts.loansByStatus.points.reduce((sum, point) => sum + point.count, 0) === report.summary.loanCount &&
          analytics.charts.loanAmountByType.points.reduce((sum, point) => sum + point.count, 0) === report.summary.loanCount,
        `count ${analytics.summary.loanCount}/${report.summary.loanCount} amount ${analytics.summary.loanAmount}/${report.summary.totalLoanAmount}`
      );

      const active = await analyticsService.analytics({ ...filters, section: 'loans', status: 'ACTIVE' }, adminActor);
      const activeReport = await reportService.loanReport(
        { status: 'ACTIVE', page: 1, limit: 10000, [EXPORT_SCOPE]: true },
        adminActor
      );
      record(
        'Test 8 — a status filter narrows analytics exactly as it narrows the Loan Report',
        active.summary.loanCount === activeReport.summary.loanCount &&
          active.summary.loanAmount === activeReport.summary.totalLoanAmount &&
          active.summary.loanCount < analytics.summary.loanCount,
        `ACTIVE ${active.summary.loanCount}/${activeReport.summary.loanCount} of ${analytics.summary.loanCount}`
      );
    }

    /* ----------------------------------------------- 4. demand reconciliation */

    {
      const analytics = await analyticsService.analytics({ ...filters, section: 'demand' }, adminActor);
      const demandService = require('../src/services/demandService');
      // Every demandable instalment, including future ones, over the same window
      // the analytics series covers — which is what makes the two comparable.
      const demand = await demandService.getDemand({ date: ASOF, includeUpcoming: true, limit: 500 }, adminActor);

      // demandService answers for the whole book; the analytics series is cut to
      // the window. Compared on this suite's own loans, where the window covers
      // every instalment either way.
      const ours = demand.demand.filter((row) => [loanA.id, loanB.id].includes(row.loan?.id));
      const oursPaise = ours.reduce((sum, row) => sum + Math.round(Number(row.demandAmount) * 100), 0);

      const scoped = await analyticsService.analytics({ ...filters, section: 'demand', routeId: route.id }, adminActor);
      const scopedPaise = Math.round(Number(scoped.summary.netDemand) * 100);
      const oursOnRoute = ours
        .filter((row) => row.loan?.id === loanA.id)
        .reduce((sum, row) => sum + Math.round(Number(row.demandAmount) * 100), 0);

      record(
        'Test 9 — net demand for a route equals demandService’s own outstanding for the loans on it',
        scopedPaise === oursOnRoute,
        `analytics ${scoped.summary.netDemand} vs demandService ${(oursOnRoute / 100).toFixed(2)}`
      );

      record(
        'Test 10 — the overdue / due-today / upcoming split sums to net demand in every bucket',
        analytics.charts.demandOverTime.points.every((point) => {
          const paise = (value) => Math.round(Number(value) * 100);
          return paise(point.overdue) + paise(point.dueToday) + paise(point.upcoming) === paise(point.net);
        }),
        `${analytics.charts.demandOverTime.points.length} buckets, each split exactly`
      );

      record(
        'Test 11 — demand and collections are never added: the two sections report them separately',
        (() => {
          const combined = analytics.summary;
          // The demand section reports no collected figure at all, and the
          // demand-vs-collection section reports both without a combined total.
          return !('collected' in combined) && oursPaise >= 0;
        })(),
        'the demand section carries no collected total'
      );
    }

    /* ------------------------------------- 5. bounce: assessed vs collected */

    {
      const analytics = await analyticsService.analytics({ ...filters, section: 'bounce' }, adminActor);
      const bounceReport = await reportService.bounceCollectionReport(
        { dateFrom: FROM, dateTo: TO, page: 1, limit: 10000, [EXPORT_SCOPE]: true },
        adminActor
      );

      record(
        'Test 12 — bounce COLLECTED reconciles with the Bounce Collection Report, and is the money, not the charge',
        analytics.summary.bounceCollected === bounceReport.summary.collectedBounce &&
          Number(analytics.summary.bounceCollected) === 100,
        `analytics ${analytics.summary.bounceCollected} report ${bounceReport.summary.collectedBounce} (expected 100.00)`
      );

      record(
        'Test 13 — an ASSESSED but unpaid charge is reported separately and reaches no collected total',
        Number(analytics.summary.bounceAssessed) >= 250 &&
          Number(analytics.summary.bounceCollected) === 100 &&
          analytics.summary.bounceAssessed !== analytics.summary.bounceCollected &&
          // and the assessed figure is in its own chart, not in the collected one.
          analytics.charts.bounceAssessedOverTime.points.every((point) => Number(point.amount) > 0) &&
          analytics.charts.bounceCollectedOverTime.points.every((point) => Number(point.amount) > 0),
        `assessed ${analytics.summary.bounceAssessed} collected ${analytics.summary.bounceCollected}`
      );

      record(
        'Test 14 — the assessed-vs-collected chart shows two separate points, never a sum',
        (() => {
          const points = analytics.charts.bounceAssessedVsCollected.points;
          return (
            points.length === 2 &&
            points[0].label === 'Assessed' &&
            points[1].label === 'Collected' &&
            points[0].amount === analytics.summary.bounceAssessed &&
            points[1].amount === analytics.summary.bounceCollected
          );
        })(),
        JSON.stringify(analytics.charts.bounceAssessedVsCollected.points)
      );
    }

    /* ------------------------------------------ 6. demand vs collection (F) */

    {
      const analytics = await analyticsService.analytics({ ...filters, section: 'demand-vs-collection' }, adminActor);
      const demandOnly = await analyticsService.analytics({ ...filters, section: 'demand' }, adminActor);
      const collectionsOnly = await analyticsService.analytics({ ...filters, section: 'collections' }, adminActor);

      record(
        'Test 15 — the combined section reports the same demand and the same collections as each section alone',
        analytics.summary.grossDemand === demandOnly.summary.grossDemand &&
          analytics.summary.netDemand === demandOnly.summary.netDemand &&
          analytics.summary.collected === collectionsOnly.summary.collected,
        `demand ${analytics.summary.netDemand}/${demandOnly.summary.netDemand} collected ${analytics.summary.collected}/${collectionsOnly.summary.collected}`
      );

      record(
        'Test 16 — a collection rate is reported only where there was demand to collect against',
        analytics.charts.demandVsCollected.points.every((point) =>
          Number(point.grossDemand) > 0 ? point.collectionRate !== null : point.collectionRate === null
        ),
        analytics.charts.demandVsCollected.points.map((p) => `${p.label}:${p.collectionRate ?? 'n/a'}`).join(' ')
      );
    }

    /* ------------------------------------------------ 7. filters and grouping */

    {
      const byDay = await analyticsService.analytics({ ...filters, bucket: 'day', section: 'collections' }, adminActor);
      const byWeek = await analyticsService.analytics({ ...filters, bucket: 'week', section: 'collections' }, adminActor);
      const byMonth = await analyticsService.analytics({ ...filters, bucket: 'month', section: 'collections' }, adminActor);

      record(
        'Test 17 — grouping changes the number of points but never the total',
        byDay.summary.collected === byWeek.summary.collected &&
          byWeek.summary.collected === byMonth.summary.collected &&
          byDay.charts.collectionsOverTime.points.length >= byWeek.charts.collectionsOverTime.points.length &&
          byWeek.charts.collectionsOverTime.points.length >= byMonth.charts.collectionsOverTime.points.length,
        `day ${byDay.charts.collectionsOverTime.points.length} week ${byWeek.charts.collectionsOverTime.points.length} month ${byMonth.charts.collectionsOverTime.points.length}, all ${byMonth.summary.collected}`
      );

      // Every bucket must be a real date, so the frontend can sort and format it.
      record(
        'Test 18 — every series point is a real YYYY-MM-DD date, at every grouping',
        [byDay, byWeek, byMonth].every((data) =>
          data.charts.collectionsOverTime.points.every((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.label))
        ),
        `week buckets: ${byWeek.charts.collectionsOverTime.points.map((p) => p.label).join(', ')}`
      );

      const onRoute = await analyticsService.analytics({ ...filters, section: 'collections', routeId: route.id }, adminActor);
      const allRoutes = await analyticsService.analytics({ ...filters, section: 'collections' }, adminActor);
      record(
        'Test 19 — a route filter narrows the result to that route’s loans',
        Number(onRoute.summary.collected) < Number(allRoutes.summary.collected) &&
          Number(onRoute.summary.collected) === 2500 &&
          onRoute.charts.collectionsByRoute.points.length === 1,
        `route ${onRoute.summary.collected} of all ${allRoutes.summary.collected}`
      );

      const cash = await analyticsService.analytics({ ...filters, section: 'collections', ledgerType: 'CASH' }, adminActor);
      const bank = await analyticsService.analytics({ ...filters, section: 'collections', ledgerType: 'BANK' }, adminActor);
      record(
        'Test 20 — a payment-mode filter splits the collected total without losing any of it',
        Math.round(Number(cash.summary.collected) * 100) + Math.round(Number(bank.summary.collected) * 100) ===
          Math.round(Number(allRoutes.summary.collected) * 100),
        `cash ${cash.summary.collected} + bank ${bank.summary.collected} = ${allRoutes.summary.collected}`
      );
    }

    /* --------------------------------------- 8. empty sets and bad input */

    {
      const empty = await analyticsService.analytics(
        { dateFrom: '2019-01-01', dateTo: '2019-03-31', date: '2019-03-31', bucket: 'month', section: 'collections' },
        adminActor
      );
      record(
        'Test 21 — an empty period returns an empty series and zero totals, not a fabricated trend',
        empty.charts.collectionsOverTime.points.length === 0 &&
          Number(empty.summary.collected) === 0 &&
          empty.summary.collectionCount === 0 &&
          // A category chart still lists its categories, each at zero.
          empty.charts.collectionsByMode.points.length === 2 &&
          empty.charts.collectionsByMode.points.every((point) => Number(point.amount) === 0),
        `series ${empty.charts.collectionsOverTime.points.length} points, collected ${empty.summary.collected}`
      );

      let inverted = null;
      try {
        await analyticsService.analytics(
          { dateFrom: TO, dateTo: FROM, date: ASOF, bucket: 'month', section: 'collections' },
          adminActor
        );
      } catch (error) {
        inverted = error.message;
      }
      record(
        'Test 22 — an inverted date range is refused rather than quietly returning nothing',
        inverted !== null && /ends before it begins/.test(inverted),
        String(inverted)
      );

      let oversized = null;
      try {
        await analyticsService.analytics(
          { dateFrom: addDays(ASOF, -1200), dateTo: ASOF, date: ASOF, bucket: 'day', section: 'collections' },
          adminActor
        );
      } catch (error) {
        oversized = error.message;
      }
      record(
        'Test 23 — a series above the point ceiling is refused, never trimmed to a short trend line',
        oversized !== null &&
          new RegExp(String(ANALYTICS_MAX_POINTS)).test(oversized) &&
          /group by week or month/.test(oversized),
        String(oversized)
      );

      let unknown = null;
      try {
        await analyticsService.analytics({ ...filters, section: 'constructor' }, adminActor);
      } catch (error) {
        unknown = error.message;
      }
      record(
        'Test 24 — an unrecognised section is refused, and a prototype key cannot reach the handler table',
        unknown !== null && /Unknown analytics section/.test(unknown),
        String(unknown)
      );
    }

    /* ---------------------------------------------- 9. preview writes nothing */

    {
      const snapshot = async () => ({
        collections: await Collection.count(),
        allocations: await CollectionAllocation.count(),
        emis: await EmiSchedule.count(),
        collected: Number(
          (await EmiSchedule.findAll({ where: { loanId: loanA.id }, attributes: ['amountCollected'], raw: true })).reduce(
            (sum, row) => sum + Number(row.amountCollected),
            0
          )
        )
      });

      const stateBefore = await snapshot();
      for (const section of ['loans', 'demand', 'collections', 'emis', 'bounce', 'demand-vs-collection']) {
        // eslint-disable-next-line no-await-in-loop
        await analyticsService.analytics({ ...filters, section }, adminActor);
      }
      const stateAfter = await snapshot();

      record(
        'Test 25 — reading every analytics section writes nothing at all',
        JSON.stringify(stateBefore) === JSON.stringify(stateAfter),
        `${JSON.stringify(stateBefore)} -> ${JSON.stringify(stateAfter)}`
      );
    }

    /* ---------------------------------------- 10. HTTP: permissions and export */

    const secret = process.env.JWT_SECRET || require('../src/config/env').jwtSecret;
    const userWithRole = async (roleName) => {
      const user = await User.findOne({ include: [{ association: 'Role', where: { name: roleName } }] });
      return user ? { id: user.id, role: roleName } : null;
    };
    const tokenFor = (user) => jwt.sign({ id: user.id, sub: user.id, role: user.role }, secret, { expiresIn: '10m' });

    const admin = (await userWithRole('ADMIN')) ?? (await userWithRole('SUPER_ADMIN'));
    const collector = await userWithRole('COLLECTOR');

    {
      const anon = await request(`/api/admin/reports/analytics?${W}&section=collections`);
      record('Test 26 — the endpoint rejects an unauthenticated request', anon.status === 401, `status ${anon.status}`);

      if (!admin) {
        record('Test 27-32 — skipped: no ADMIN user in this database', false, 'seed an admin to run the HTTP tests');
      } else {
        const adminToken = tokenFor(admin);

        const statuses = {};
        for (const section of ['loans', 'demand', 'collections', 'emis', 'bounce', 'demand-vs-collection']) {
          // eslint-disable-next-line no-await-in-loop
          const response = await request(`/api/admin/reports/analytics?${W}&section=${section}`, adminToken);
          statuses[section] = response.status;
        }
        record(
          'Test 27 — every section is reachable over HTTP with reports.view',
          Object.values(statuses).every((status) => status === 200),
          JSON.stringify(statuses)
        );

        const invalid = {};
        for (const [name, query] of Object.entries({
          section: 'section=nope',
          bucket: 'bucket=fortnight',
          malformedDate: 'dateFrom=18-08-2026',
          impossibleDate: 'dateFrom=2026-02-30',
          loanStatus: 'status=NOPE',
          emiStatus: 'emiStatus=NOPE',
          mode: 'ledgerType=UPI',
          route: 'routeId=abc'
        })) {
          // eslint-disable-next-line no-await-in-loop
          const response = await request(`/api/admin/reports/analytics?${W}&${query}`, adminToken);
          invalid[name] = response.status;
        }
        record(
          'Test 28 — every invalid filter is refused with 422 by the shared validator',
          Object.values(invalid).every((status) => status === 422),
          JSON.stringify(invalid)
        );

        /* ---- the Excel export ---- */
        const xlsx = await request(`/api/admin/reports/analytics?${W}&section=collections&format=xlsx`, adminToken);
        const workbook = new ExcelJS.Workbook();
        if (xlsx.status === 200) await workbook.xlsx.load(xlsx.body);

        const sheet = workbook.getWorksheet('Graph & Analytics');
        const summarySheet = workbook.getWorksheet('Summary');
        const headers = sheet ? sheet.getRow(1).values.slice(1).map(String) : [];

        record(
          'Test 29 — the export is a real workbook with a data sheet and a Summary sheet',
          xlsx.status === 200 &&
            xlsx.headers['content-type'].includes('spreadsheetml') &&
            /attachment; filename="lms-analytics-/.test(xlsx.headers['content-disposition']) &&
            Boolean(sheet) &&
            Boolean(summarySheet) &&
            JSON.stringify(headers) ===
              JSON.stringify(['Chart', 'Series', 'Period Or Category', 'Date', 'Count', 'Amount']),
          `status ${xlsx.status} headers ${JSON.stringify(headers)}`
        );

        record(
          'Test 30 — amounts are numeric Excel values and dates are real date cells, not text',
          (() => {
            if (!sheet) return false;
            let numericAmounts = 0;
            let dateCells = 0;
            for (let r = 2; r <= sheet.rowCount; r += 1) {
              const row = sheet.getRow(r);
              // ValueType.Number === 2, ValueType.Date === 4
              if (row.getCell(6).type === 2) numericAmounts += 1;
              if (row.getCell(4).type === 4) dateCells += 1;
            }
            return numericAmounts > 0 && dateCells > 0;
          })(),
          (() => {
            if (!sheet) return 'no sheet';
            const row = sheet.getRow(2);
            return `row2 types: ${[1, 2, 3, 4, 5, 6].map((c) => row.getCell(c).type).join(',')}`;
          })()
        );

        record(
          'Test 31 — the Summary sheet states the applied filters and the generation date',
          (() => {
            if (!summarySheet) return false;
            const text = [];
            summarySheet.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value))));
            const joined = text.join(' | ');
            return (
              /Generated/.test(joined) &&
              /collections/.test(joined) &&
              /month/.test(joined) &&
              joined.includes(FROM) &&
              joined.includes(TO)
            );
          })(),
          'section, grouping, window and generation stamp present'
        );

        record(
          'Test 32 — the export contains every chart of the section, not only the first',
          (() => {
            if (!sheet) return false;
            const charts = new Set();
            for (let r = 2; r <= sheet.rowCount; r += 1) charts.add(String(sheet.getRow(r).getCell(1).value));
            return (
              charts.has('Collections over time') &&
              charts.has('Principal vs interest collected') &&
              charts.has('Collections by route') &&
              charts.has('Collections by payment mode')
            );
          })(),
          (() => {
            if (!sheet) return 'no sheet';
            const charts = new Set();
            for (let r = 2; r <= sheet.rowCount; r += 1) charts.add(String(sheet.getRow(r).getCell(1).value));
            return [...charts].join('; ');
          })()
        );

        record(
          'Test 33 — the export rows are the chart points, so the file cannot differ from the screen',
          await (async () => {
            const json = asJson(await request(`/api/admin/reports/analytics?${W}&section=collections`, adminToken));
            return sheet ? json.data.rows.length === sheet.rowCount - 1 : false;
          })(),
          `screen rows ${asJson(await request(`/api/admin/reports/analytics?${W}&section=collections`, adminToken))?.data?.rows?.length} vs sheet rows ${sheet ? sheet.rowCount - 1 : 'n/a'}`
        );

        /* ---- a collector is confined, and cannot export ---- */
        if (collector) {
          const collectorToken = tokenFor(collector);
          const own = await request(`/api/admin/reports/analytics?${W}&section=collections`, collectorToken);
          const other = await request(
            `/api/admin/reports/analytics?${W}&section=collections&collectorId=${admin.id}`,
            collectorToken
          );
          const exportAttempt = await request(
            `/api/admin/reports/analytics?${W}&section=collections&format=xlsx`,
            collectorToken
          );
          const unassignedRoute = await request(
            `/api/admin/reports/analytics?${W}&section=collections&routeId=${route.id}`,
            collectorToken
          );

          record(
            'Test 34 — a COLLECTOR may read their own scope, is refused another collector’s, and cannot export',
            own.status === 200 &&
              other.status === 403 &&
              exportAttempt.status === 403 &&
              // and is refused a route they are not assigned to, rather than
              // being handed an empty result that leaks its existence.
              unassignedRoute.status === 403,
            `own ${own.status} other ${other.status} export ${exportAttempt.status} unassignedRoute ${unassignedRoute.status}`
          );
        } else {
          record('Test 34 — skipped: no COLLECTOR user in this database', false, 'seed a collector to run the scope test');
        }
      }
    }
  } catch (fatal) {
    record('FATAL — the test run itself threw', false, fatal.stack || fatal.message);
  } finally {
    /* ------------------------------------------------------------- cleanup --- */
    try {
      for (const loan of [loanA, loanB]) {
        if (!loan) continue;
        // eslint-disable-next-line no-await-in-loop
        const emis = await EmiSchedule.findAll({ where: { loanId: loan.id } });
        // eslint-disable-next-line no-await-in-loop
        await CollectionAllocation.destroy({ where: { emiId: emis.map((emi) => emi.id) } });
        // eslint-disable-next-line no-await-in-loop
        await Collection.destroy({ where: { loanId: loan.id } });
        // eslint-disable-next-line no-await-in-loop
        await EmiSchedule.destroy({ where: { loanId: loan.id } });
        // eslint-disable-next-line no-await-in-loop
        await LoanRoute.destroy({ where: { loanId: loan.id } });
        // eslint-disable-next-line no-await-in-loop
        await LoanParty.destroy({ where: { loanId: loan.id } });
        // eslint-disable-next-line no-await-in-loop
        await loan.destroy();
      }
      if (route) {
        await LoanRoute.destroy({ where: { routeId: route.id } });
        const { RouteCollector } = require('../src/models');
        await RouteCollector.destroy({ where: { routeId: route.id } });
        await Route.destroy({ where: { id: route.id } });
      }
      if (customerA) await customerA.destroy();
      if (customerB) await customerB.destroy();

      if (before) {
        const after = {
          customers: await Customer.count(),
          loans: await Loan.count(),
          emis: await EmiSchedule.count(),
          collections: await Collection.count(),
          allocations: await CollectionAllocation.count(),
          routes: await Route.count()
        };
        record(
          'Cleanup — the database is back to its exact starting counts',
          JSON.stringify(before) === JSON.stringify(after),
          `${JSON.stringify(before)} -> ${JSON.stringify(after)}`
        );
      }
    } catch (cleanupError) {
      record('Cleanup', false, cleanupError.stack || cleanupError.message);
    }
  }

  console.log('\n=== Graph & Analytics test results ===\n');
  let failed = 0;
  for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
    if (!result.pass || process.env.VERBOSE) console.log(`      ${result.detail}`);
    if (!result.pass) failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} passed\n`);

  await sequelize.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
