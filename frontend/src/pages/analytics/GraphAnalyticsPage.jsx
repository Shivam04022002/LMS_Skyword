import { useCallback, useEffect, useMemo, useState } from 'react';
import AlertMessage from '../../components/common/AlertMessage';
import usePermissions from '../../hooks/usePermissions';
import ChartCard from '../../components/charts/ChartCard';
import ReportSummaryCards from '../../components/reports/ReportSummaryCards';
import ReportToolbar from '../../components/reports/ReportToolbar';
import { getAnalytics } from '../../services/reportService';
import { getRoutes } from '../../services/routeService';
import { fetchUsers } from '../../services/userService';
import { formatCurrency, LOAN_STATUSES, LOAN_TYPES } from '../../utils/loanConstants';
import { PERMISSIONS } from '../../utils/permissions';
import { ANALYTICS_BUCKETS, ANALYTICS_SECTIONS, REPORTS } from '../../utils/reportConstants';
import { today } from '../../utils/today';

/**
 * Graph & Analytics.
 *
 * Draws the same figures the five report pages produce. Nothing on this page
 * calculates anything: every number comes from the backend's analytics endpoint,
 * which aggregates the same stored columns the reports read, so a chart and a
 * report for identical filters agree by construction rather than by coincidence.
 *
 * One section is loaded at a time. A page that drew all six would run every
 * aggregation on every filter change, and most of it would be off screen.
 */

const EMI_STATUSES = ['PENDING', 'DUE', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED'];
const LEDGER_TYPES = ['CASH', 'BANK'];

/** Which filters each section actually uses. A filter that changes nothing is not shown. */
const SECTION_FILTERS = {
  [ANALYTICS_SECTIONS.LOANS]: ['dateFrom', 'dateTo', 'bucket', 'routeId', 'collectorId', 'status', 'loanType'],
  [ANALYTICS_SECTIONS.DEMAND]: ['date', 'dateFrom', 'dateTo', 'bucket', 'routeId', 'collectorId'],
  [ANALYTICS_SECTIONS.COLLECTIONS]: ['dateFrom', 'dateTo', 'bucket', 'routeId', 'collectorId', 'ledgerType'],
  [ANALYTICS_SECTIONS.EMIS]: ['date', 'dateFrom', 'dateTo', 'bucket', 'routeId', 'collectorId', 'emiStatus'],
  [ANALYTICS_SECTIONS.BOUNCE]: ['dateFrom', 'dateTo', 'bucket', 'routeId', 'collectorId'],
  [ANALYTICS_SECTIONS.DEMAND_VS_COLLECTION]: ['date', 'dateFrom', 'dateTo', 'bucket', 'routeId', 'collectorId']
};

const SECTIONS = [
  { key: ANALYTICS_SECTIONS.LOANS, label: 'Loans', icon: 'bi-cash-coin' },
  { key: ANALYTICS_SECTIONS.DEMAND, label: 'Demand', icon: 'bi-calendar-check' },
  { key: ANALYTICS_SECTIONS.COLLECTIONS, label: 'Collections', icon: 'bi-wallet2' },
  { key: ANALYTICS_SECTIONS.EMIS, label: 'Instalments', icon: 'bi-list-check' },
  { key: ANALYTICS_SECTIONS.BOUNCE, label: 'Bounce', icon: 'bi-exclamation-octagon' },
  { key: ANALYTICS_SECTIONS.DEMAND_VS_COLLECTION, label: 'Demand vs collection', icon: 'bi-bar-chart' }
];

/** A chart defaults to the type that reads its data most honestly. */
const DEFAULT_TYPE = {
  loansByStatus: 'pie',
  loanAmountByType: 'pie',
  collectionsByMode: 'pie',
  emiStatusDistribution: 'pie',
  disbursementOverTime: 'bar',
  loansCreatedOverTime: 'line',
  demandOverTime: 'line',
  collectionsOverTime: 'line',
  emiDemandVsCollected: 'bar',
  emiOutstandingOverTime: 'line',
  bounceAssessedOverTime: 'bar',
  bounceCollectedOverTime: 'bar',
  demandVsCollected: 'bar'
};

/** Charts whose measure is a count of records rather than money. */
const COUNT_CHARTS = new Set(['dpdDistribution']);

export default function GraphAnalyticsPage() {
  const { can } = usePermissions();

  const emptyFilters = useMemo(
    () => ({
      section: ANALYTICS_SECTIONS.COLLECTIONS,
      bucket: ANALYTICS_BUCKETS.MONTH,
      date: today(),
      dateFrom: '',
      dateTo: '',
      routeId: '',
      collectorId: '',
      status: '',
      loanType: '',
      emiStatus: '',
      ledgerType: ''
    }),
    []
  );

  // `filters` is what the controls hold; `applied` is what produced what is on
  // screen. Keeping them apart is what makes Apply mean something, and what lets
  // the export send exactly the filters behind the charts rather than whatever
  // the controls happen to show.
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [data, setData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [collectors, setCollectors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getRoutes({ limit: 100 })
      .then((response) => setRoutes(response.data.routes ?? []))
      .catch(() => setRoutes([]));
  }, []);

  /*
   * The collector list comes from the users endpoint, which needs users.view —
   * a permission a reports reader need not hold. Asked for only when the caller
   * has it, as every other page that offers this filter does, so no one is sent
   * to a 403 to populate a dropdown. Without it the filter simply does not
   * appear; the analytics endpoint still scopes a COLLECTOR to their own routes
   * either way, because that is decided server-side from the token.
   */
  useEffect(() => {
    if (!can(PERMISSIONS.USERS_VIEW)) return;
    fetchUsers({ role: 'COLLECTOR', status: 'ACTIVE', limit: 100 })
      .then((response) => setCollectors(response.data.users ?? []))
      .catch(() => setCollectors([]));
  }, [can]);

  const load = useCallback(async (requested) => {
    setLoading(true);
    setError('');
    try {
      const response = await getAnalytics(requested);
      setData(response.data);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the analytics.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(applied);
  }, [load, applied]);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  // Switching section applies immediately: it is a change of subject, not a
  // filter to compose, and leaving the old section's charts on screen under a new
  // tab would be a lie about what is loaded.
  const selectSection = (section) => {
    const next = { ...filters, section };
    setFilters(next);
    setApplied(next);
  };

  const shows = (key) => (SECTION_FILTERS[applied.section] ?? []).includes(key);
  const charts = data?.charts ?? {};
  const summary = data?.summary;

  const dirty = JSON.stringify(filters) !== JSON.stringify(applied);

  const tiles = useMemo(() => {
    if (!summary) return [];
    const tile = (key, label, value, sub, icon, accent) => ({ key, label, value, sub, icon, accent });

    switch (applied.section) {
      case ANALYTICS_SECTIONS.LOANS:
        return [
          tile('count', 'Loans', summary.loanCount ?? 0, 'matching the filters', 'bi-cash-coin', 'primary'),
          tile('amount', 'Loan amount', formatCurrency(summary.loanAmount), 'sanctioned', 'bi-currency-rupee', 'success')
        ];
      case ANALYTICS_SECTIONS.DEMAND:
        return [
          tile('emis', 'Instalments owing', summary.emiCount ?? 0, 'in the period', 'bi-list-check', 'primary'),
          tile('gross', 'Gross demand', formatCurrency(summary.grossDemand), 'instalment value', 'bi-clipboard-data', 'warning'),
          tile('net', 'Net outstanding', formatCurrency(summary.netDemand), 'still owed', 'bi-hourglass-split', 'danger')
        ];
      case ANALYTICS_SECTIONS.COLLECTIONS:
        return [
          tile('count', 'Collections', summary.collectionCount ?? 0, 'posted in the period', 'bi-receipt', 'primary'),
          tile('collected', 'Collected', formatCurrency(summary.collected), 'total received', 'bi-cash-stack', 'success'),
          tile('principal', 'Principal', formatCurrency(summary.collectedPrincipal), 'from the ledger', 'bi-pie-chart', 'info'),
          tile('interest', 'Interest', formatCurrency(summary.collectedInterest), 'from the ledger', 'bi-percent', 'secondary')
        ];
      case ANALYTICS_SECTIONS.EMIS:
        return [
          tile('count', 'Instalments', summary.emiCount ?? 0, 'in the period', 'bi-list-ol', 'primary'),
          tile('demand', 'Instalment demand', formatCurrency(summary.emiAmount), 'scheduled value', 'bi-clipboard-data', 'warning'),
          tile('collected', 'Collected', formatCurrency(summary.emiAmountCollected), 'against them', 'bi-check2-circle', 'success'),
          tile('outstanding', 'Outstanding', formatCurrency(summary.emiOutstanding), 'still owed', 'bi-hourglass-split', 'danger')
        ];
      case ANALYTICS_SECTIONS.BOUNCE:
        return [
          tile('assessed', 'Charges assessed', formatCurrency(summary.bounceAssessed), 'levied, not received', 'bi-exclamation-octagon', 'warning'),
          tile('collected', 'Actually collected', formatCurrency(summary.bounceCollected), `${summary.bounceCollectionCount ?? 0} collections`, 'bi-cash-stack', 'success')
        ];
      case ANALYTICS_SECTIONS.DEMAND_VS_COLLECTION:
        return [
          tile('gross', 'Gross demand', formatCurrency(summary.grossDemand), 'instalment value', 'bi-clipboard-data', 'warning'),
          tile('net', 'Net outstanding', formatCurrency(summary.netDemand), 'still owed', 'bi-hourglass-split', 'danger'),
          tile('collected', 'Collected', formatCurrency(summary.collected), `${summary.collectionCount ?? 0} collections`, 'bi-cash-stack', 'success')
        ];
      default:
        return [];
    }
  }, [summary, applied.section]);

  return (
    <div className="container-fluid px-0">
      <ReportToolbar
        title="Graph & Analytics"
        description="Loan, demand, collection, instalment and bounce performance as charts. Every figure is the one the matching report produces for the same filters."
        reportKey={REPORTS.ANALYTICS}
        exportFormat="xlsx"
        // The applied filters, not the pending ones: the file matches the charts.
        filters={applied}
        loading={loading}
        resultCount={data?.rows?.length}
        onRefresh={() => load(applied)}
        onReset={() => {
          setFilters(emptyFilters);
          setApplied(emptyFilters);
        }}
      />

      <AlertMessage message={error} onDismiss={() => setError('')} />

      {/* Section switch */}
      <ul className="nav nav-pills flex-wrap gap-1 mb-3" role="tablist">
        {SECTIONS.map((section) => (
          <li className="nav-item" key={section.key} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected={applied.section === section.key}
              className={`nav-link ${applied.section === section.key ? 'active' : ''}`}
              onClick={() => selectSection(section.key)}
              disabled={loading}
            >
              <i className={`bi ${section.icon} me-1`} aria-hidden="true" />
              {section.label}
            </button>
          </li>
        ))}
      </ul>

      {/* Filters */}
      <div className="card border-0 shadow-sm mb-3">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            {shows('date') ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="ga-asof">As of</label>
                <input id="ga-asof" type="date" className="form-control" value={filters.date} onChange={set('date')} />
              </div>
            ) : null}

            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="ga-from">From</label>
              <input id="ga-from" type="date" className="form-control" value={filters.dateFrom} onChange={set('dateFrom')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="ga-to">To</label>
              <input id="ga-to" type="date" className="form-control" value={filters.dateTo} onChange={set('dateTo')} />
            </div>

            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="ga-bucket">Group by</label>
              <select id="ga-bucket" className="form-select" value={filters.bucket} onChange={set('bucket')}>
                <option value={ANALYTICS_BUCKETS.DAY}>Day</option>
                <option value={ANALYTICS_BUCKETS.WEEK}>Week</option>
                <option value={ANALYTICS_BUCKETS.MONTH}>Month</option>
              </select>
            </div>

            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="ga-route">Route</label>
              <select id="ga-route" className="form-select" value={filters.routeId} onChange={set('routeId')}>
                <option value="">All routes</option>
                {routes.map((route) => (
                  <option key={route.id} value={route.id}>{route.routeCode}</option>
                ))}
              </select>
            </div>

{collectors.length > 0 ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="ga-collector">Collector</label>
                {/*
                  A collector FILTER, not a grouping. A collection records who
                  keyed it, not who collected it, and a route can have several
                  collectors — so attributing an amount to one of them would
                  either misreport or double-count. Filtering by collector means
                  "the routes this collector is assigned to", which is exactly
                  what every other report means by it.
                */}
                <select id="ga-collector" className="form-select" value={filters.collectorId} onChange={set('collectorId')}>
                  <option value="">All collectors</option>
                  {collectors.map((collector) => (
                    <option key={collector.id} value={collector.id}>{collector.name}</option>
                  ))}
                </select>
              </div>
            ) : null}

            {shows('status') ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="ga-status">Loan status</label>
                <select id="ga-status" className="form-select" value={filters.status} onChange={set('status')}>
                  <option value="">All statuses</option>
                  {LOAN_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </div>
            ) : null}

            {shows('loanType') ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="ga-type">Loan type</label>
                <select id="ga-type" className="form-select" value={filters.loanType} onChange={set('loanType')}>
                  <option value="">All types</option>
                  {LOAN_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
            ) : null}

            {shows('emiStatus') ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="ga-emi-status">Instalment status</label>
                <select id="ga-emi-status" className="form-select" value={filters.emiStatus} onChange={set('emiStatus')}>
                  <option value="">All statuses</option>
                  {EMI_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </div>
            ) : null}

            {shows('ledgerType') ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="ga-mode">Payment mode</label>
                <select id="ga-mode" className="form-select" value={filters.ledgerType} onChange={set('ledgerType')}>
                  <option value="">All modes</option>
                  {LEDGER_TYPES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              </div>
            ) : null}

            <div className="col-12 col-xl-auto d-flex gap-2">
              <button type="button" className="btn btn-primary" onClick={() => setApplied(filters)} disabled={loading || !dirty}>
                <i className="bi bi-funnel me-1" aria-hidden="true" />
                Apply
              </button>
            </div>
          </div>

          {dirty ? (
            <p className="form-text mb-0 mt-2">
              <i className="bi bi-info-circle me-1" aria-hidden="true" />
              The charts below still show the previously applied filters. Choose Apply to use these.
            </p>
          ) : null}
        </div>
      </div>

      {/* What is actually on screen, stated rather than implied */}
      {data ? (
        <div className="d-flex flex-wrap gap-2 align-items-center mb-3 small">
          <span className="text-secondary">Showing</span>
          <span className="badge text-bg-light border">
            {data.period.from} to {data.period.to}
          </span>
          <span className="badge text-bg-light border">grouped by {data.bucket}</span>
          {shows('date') ? <span className="badge text-bg-light border">as of {data.asOf}</span> : null}
          {data.appliedFilters.routeId ? (
            <span className="badge text-bg-light border">
              route {routes.find((route) => String(route.id) === String(data.appliedFilters.routeId))?.routeCode ?? data.appliedFilters.routeId}
            </span>
          ) : null}
          {data.appliedFilters.collectorId ? (
            <span className="badge text-bg-light border">
              collector {collectors.find((c) => String(c.id) === String(data.appliedFilters.collectorId))?.name ?? data.appliedFilters.collectorId}
            </span>
          ) : null}
          {data.appliedFilters.status ? <span className="badge text-bg-light border">loan {data.appliedFilters.status}</span> : null}
          {data.appliedFilters.loanType ? <span className="badge text-bg-light border">{data.appliedFilters.loanType}</span> : null}
          {data.appliedFilters.emiStatus ? <span className="badge text-bg-light border">instalment {data.appliedFilters.emiStatus}</span> : null}
          {data.appliedFilters.ledgerType ? <span className="badge text-bg-light border">{data.appliedFilters.ledgerType}</span> : null}
        </div>
      ) : null}

      {tiles.length > 0 ? <div className="mb-4"><ReportSummaryCards tiles={tiles} /></div> : null}

      {applied.section === ANALYTICS_SECTIONS.BOUNCE ? (
        <div className="alert alert-info d-flex align-items-start gap-2">
          <i className="bi bi-info-circle-fill mt-1" aria-hidden="true" />
          <div>
            <strong>A charge levied is not money received.</strong> Charges assessed come from the instalments they were
            levied on; bounce collected is money that actually arrived. The two are charted separately and never added,
            so an unpaid charge contributes nothing to any collected figure.
          </div>
        </div>
      ) : null}

      {applied.section === ANALYTICS_SECTIONS.DEMAND_VS_COLLECTION ? (
        <div className="alert alert-info d-flex align-items-start gap-2">
          <i className="bi bi-info-circle-fill mt-1" aria-hidden="true" />
          <div>
            <strong>Demand is not money received.</strong> Demand is instalment value owed; collected is what was posted.
            They are charted side by side and never summed. A collection rate is shown only for a period that had demand
            to collect against — where there was none it is left blank, because a rate over nothing is undefined, not zero.
          </div>
        </div>
      ) : null}

      <div className="row g-3">
        {Object.entries(charts).map(([key, chart]) => (
          <div
            className={chart.kind === 'series' ? 'col-12' : 'col-12 col-xl-6'}
            key={key}
          >
            <ChartCard
              chart={chart}
              bucket={data?.bucket ?? applied.bucket}
              loading={loading}
              valueKind={COUNT_CHARTS.has(key) ? 'count' : 'money'}
              defaultType={DEFAULT_TYPE[key] ?? 'bar'}
            />
          </div>
        ))}

        {/* Loading with nothing yet drawn, and the no-charts case. */}
        {Object.keys(charts).length === 0 ? (
          <div className="col-12">
            <div className="card border-0 shadow-sm">
              <div className="card-body text-center text-secondary py-5">
                {loading ? (
                  <>
                    <span className="spinner-border text-primary" role="status" aria-hidden="true" />
                    <p className="mt-2 mb-0">Loading analytics…</p>
                  </>
                ) : (
                  <p className="mb-0">No charts for this selection.</p>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <p className="form-text mt-3 mb-0">
        Exported as Excel, this writes every point of every chart above for the applied filters — not only the points
        currently visible — with the filters and the generation date on a Summary sheet.
      </p>
    </div>
  );
}
