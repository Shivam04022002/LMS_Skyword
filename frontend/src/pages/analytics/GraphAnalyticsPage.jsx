import { useCallback, useEffect, useMemo, useState } from 'react';
import AlertMessage from '../../components/common/AlertMessage';
import usePermissions from '../../hooks/usePermissions';
import AnalyticsFilters from '../../components/analytics/AnalyticsFilters';
import AnalyticsHeader from '../../components/analytics/AnalyticsHeader';
import AnalyticsMetricCards from '../../components/analytics/AnalyticsMetricCards';
import AnalyticsSectionTabs from '../../components/analytics/AnalyticsSectionTabs';
import ChartCard from '../../components/charts/ChartCard';
import { getAnalytics } from '../../services/reportService';
import { getRoutes } from '../../services/routeService';
import { fetchUsers } from '../../services/userService';
import { formatCurrency, LOAN_STATUSES, LOAN_TYPES } from '../../utils/loanConstants';
import { PERMISSIONS } from '../../utils/permissions';
import { ANALYTICS_BUCKETS, ANALYTICS_SECTIONS } from '../../utils/reportConstants';
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
 *
 * The header, tabs, filter panel and metric cards are this page's own components
 * rather than the shared report ones: it needs an Apply step, a dirty-state
 * notice and a filter summary that no report page has. The shared ReportToolbar
 * and ReportSummaryCards are used unchanged by five report pages and are left
 * alone; the export is the same call, with the same permission gate and the same
 * applied filters.
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
  { key: ANALYTICS_SECTIONS.DEMAND_VS_COLLECTION, label: 'Demand vs Collection', icon: 'bi-bar-chart' }
];

const SECTION_LABEL = Object.fromEntries(SECTIONS.map((section) => [section.key, section.label]));

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

/** The caveat each section needs stated before its charts are read. */
const SECTION_NOTE = {
  [ANALYTICS_SECTIONS.BOUNCE]: {
    title: 'A charge levied is not money received.',
    body:
      'Charges assessed come from the instalments they were levied on; bounce collected is money that actually arrived. The two are charted separately and never added, so an unpaid charge contributes nothing to any collected figure.'
  },
  [ANALYTICS_SECTIONS.DEMAND_VS_COLLECTION]: {
    title: 'Demand is not money received.',
    body:
      'Demand is instalment value owed; collected is what was posted. They are charted side by side and never summed. A collection rate is shown only for a period that had demand to collect against — where there was none it is left blank, because a rate over nothing is undefined, not zero.'
  }
};

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

  /*
   * The applied-filter summary, built from what the BACKEND echoed back rather
   * than from the controls, so it describes the data on screen and not a pending
   * edit to the filters.
   */
  const chips = useMemo(() => {
    if (!data) return [];

    const list = [
      { key: 'section', label: '', value: SECTION_LABEL[data.section] ?? data.section, icon: 'bi-collection' },
      { key: 'period', label: '', value: `${data.period.from} → ${data.period.to}`, icon: 'bi-calendar-range' },
      { key: 'bucket', label: 'by', value: data.bucket, icon: 'bi-bar-chart-steps' }
    ];

    if ((SECTION_FILTERS[data.section] ?? []).includes('date')) {
      list.push({ key: 'asOf', label: 'as of', value: data.asOf, icon: 'bi-clock-history' });
    }

    const active = data.appliedFilters ?? {};
    if (active.routeId) {
      const match = routes.find((route) => String(route.id) === String(active.routeId));
      list.push({ key: 'route', label: 'Route', value: match?.routeCode ?? active.routeId, icon: 'bi-signpost-split' });
    }
    if (active.collectorId) {
      const match = collectors.find((collector) => String(collector.id) === String(active.collectorId));
      list.push({ key: 'collector', label: 'Collector', value: match?.name ?? active.collectorId, icon: 'bi-person-badge' });
    }
    if (active.status) list.push({ key: 'status', label: 'Loan', value: active.status, icon: 'bi-tag' });
    if (active.loanType) list.push({ key: 'loanType', label: 'Type', value: active.loanType, icon: 'bi-diagram-3' });
    if (active.emiStatus) list.push({ key: 'emiStatus', label: 'Instalment', value: active.emiStatus, icon: 'bi-list-check' });
    if (active.ledgerType) list.push({ key: 'ledgerType', label: 'Mode', value: active.ledgerType, icon: 'bi-credit-card' });

    return list;
  }, [data, routes, collectors]);

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

  const note = SECTION_NOTE[applied.section];
  const chartEntries = Object.entries(charts);

  return (
    <div className="lms-analytics-page container-fluid px-0">
      <AnalyticsHeader
        chips={chips}
        dirty={dirty}
        loading={loading}
        appliedFilters={applied}
        pointCount={summary?.pointCount}
        onApply={() => setApplied(filters)}
        onReset={() => {
          setFilters(emptyFilters);
          setApplied(emptyFilters);
        }}
        onRefresh={() => load(applied)}
      />

      <AlertMessage message={error} onDismiss={() => setError('')} />

      <AnalyticsSectionTabs sections={SECTIONS} active={applied.section} loading={loading} onSelect={selectSection} />

      <AnalyticsFilters
        filters={filters}
        shows={shows}
        routes={routes}
        collectors={collectors}
        buckets={ANALYTICS_BUCKETS}
        loanStatuses={LOAN_STATUSES}
        loanTypes={LOAN_TYPES}
        emiStatuses={EMI_STATUSES}
        ledgerTypes={LEDGER_TYPES}
        dirty={dirty}
        loading={loading}
        onChange={set}
        onApply={() => setApplied(filters)}
      />

      {tiles.length > 0 || loading ? (
        <div className="mb-3">
          <AnalyticsMetricCards tiles={tiles} loading={loading} />
        </div>
      ) : null}

      {note ? (
        <div className="alert alert-info d-flex align-items-start gap-2 py-2 px-3 small">
          <i className="bi bi-info-circle-fill mt-1" aria-hidden="true" />
          <div>
            <strong>{note.title}</strong> {note.body}
          </div>
        </div>
      ) : null}

      <div className="row g-3">
        {chartEntries.map(([key, chart]) => (
          // A date series needs the full width to be readable; a category
          // breakdown reads well in half, and pairs up on a wide screen.
          <div className={chart.kind === 'series' ? 'col-12' : 'col-12 col-xl-6'} key={key}>
            <ChartCard
              chart={chart}
              bucket={data?.bucket ?? applied.bucket}
              loading={loading}
              valueKind={COUNT_CHARTS.has(key) ? 'count' : 'money'}
              defaultType={DEFAULT_TYPE[key] ?? 'bar'}
            />
          </div>
        ))}

        {/* Nothing drawn yet: loading on first paint, or a selection with no charts. */}
        {chartEntries.length === 0 ? (
          <div className="col-12">
            <div className="lms-analytics-surface">
              <div className="lms-analytics-placeholder">
                {loading ? (
                  <>
                    <span className="spinner-border text-primary" role="status" aria-hidden="true" />
                    <p className="mb-0 mt-2">Loading analytics…</p>
                  </>
                ) : (
                  <>
                    <i className="bi bi-bar-chart-line lms-analytics-placeholder-icon" aria-hidden="true" />
                    <p className="mb-0">No charts for this selection.</p>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <p className="text-secondary small mt-3 mb-0">
        <i className="bi bi-file-earmark-excel me-1" aria-hidden="true" />
        Export Excel writes every point of every chart above for the applied filters — not only the points currently
        visible — with the filters and the generation date on a Summary sheet.
      </p>
    </div>
  );
}
