import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../components/common/AlertMessage';
import Spinner from '../components/common/Spinner';
import KpiCard from '../components/dashboard/KpiCard';
import EfficiencyBar from '../components/dashboard/EfficiencyBar';
import AlertList from '../components/dashboard/AlertList';
import useAuth from '../hooks/useAuth';
import usePermissions from '../hooks/usePermissions';
import { getDashboard } from '../services/dashboardService';
import { getRoutes } from '../services/routeService';
import { fetchUsers } from '../services/userService';
import { PERMISSIONS } from '../utils/permissions';
import { formatCurrency } from '../utils/loanConstants';
import { today } from '../utils/today';

const PERIODS = [
  { value: 'TODAY', label: 'Today' },
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: 'THIS_MONTH', label: 'This month' },
  { value: 'CUSTOM', label: 'Custom range' }
];

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

/**
 * Operational dashboard.
 *
 * Consumes a single `/admin/dashboard` request; every figure shown is taken
 * verbatim from that response. Nothing is totalled, averaged or re-derived here.
 */
export default function Dashboard() {
  const { user } = useAuth();
  const { can } = usePermissions();

  const emptyFilters = { period: 'TODAY', date: today(), dateFrom: '', dateTo: '', routeId: '', collectorId: '' };
  const [filters, setFilters] = useState(emptyFilters);
  const [data, setData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [collectors, setCollectors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const canSeeDashboard = can(PERMISSIONS.DASHBOARD_VIEW);

  // Filter options are only fetched where the caller has the permission; the
  // backend scopes what comes back regardless.
  useEffect(() => {
    if (!can(PERMISSIONS.ROUTES_VIEW)) return;
    getRoutes({ status: 'ACTIVE', limit: 100 }).then((r) => setRoutes(r.data.routes)).catch(() => setRoutes([]));
  }, [can]);

  useEffect(() => {
    if (!can(PERMISSIONS.USERS_VIEW)) return;
    fetchUsers({ role: 'COLLECTOR', status: 'ACTIVE', limit: 100 }).then((r) => setCollectors(r.data.users)).catch(() => setCollectors([]));
  }, [can]);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const response = await getDashboard(filters);
        setData(response.data);
      } catch (requestError) {
        setError(requestError.message || 'Unable to load the dashboard.');
        setData(null);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filters]
  );

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  if (!canSeeDashboard) {
    return (
      <div className="container-fluid px-0">
        <h1 className="h3 fw-bold mb-1">Dashboard</h1>
        <p className="text-secondary">Welcome back, {user?.name}.</p>
        <AlertMessage variant="info" message="You do not have permission to view the operational dashboard." />
      </div>
    );
  }

  if (loading) return <Spinner label="Loading dashboard…" />;

  const period = data?.period;
  const periodLabel = period ? (period.from === period.to ? formatDate(period.from) : `${formatDate(period.from)} – ${formatDate(period.to)}`) : '';

  return (
    <div className="container-fluid px-0">
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">Dashboard</h1>
          <p className="text-secondary mb-0">
            Welcome back, {user?.name}.
            {data?.scope?.restricted ? (
              <span className="badge text-bg-light border ms-2">
                <i className="bi bi-person-badge me-1" aria-hidden="true" />
                Showing your assigned routes only
              </span>
            ) : null}
          </p>
        </div>
        <button type="button" className="btn btn-outline-secondary" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? (
            <><span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />Refreshing…</>
          ) : (
            <><i className="bi bi-arrow-clockwise me-1" aria-hidden="true" />Refresh</>
          )}
        </button>
      </div>

      <AlertMessage message={error} onDismiss={() => setError('')} />

      {/* ---- filters ---- */}
      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="db-period">Period</label>
              <select id="db-period" className="form-select" value={filters.period} onChange={set('period')}>
                {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="db-date">Business date</label>
              <input id="db-date" type="date" className="form-control" value={filters.date} onChange={set('date')} />
            </div>
            {filters.period === 'CUSTOM' ? (
              <>
                <div className="col-6 col-md-3 col-xl-2">
                  <label className="form-label small fw-semibold" htmlFor="db-from">From</label>
                  <input id="db-from" type="date" className="form-control" value={filters.dateFrom} onChange={set('dateFrom')} />
                </div>
                <div className="col-6 col-md-3 col-xl-2">
                  <label className="form-label small fw-semibold" htmlFor="db-to">To</label>
                  <input id="db-to" type="date" className="form-control" value={filters.dateTo} onChange={set('dateTo')} />
                </div>
              </>
            ) : null}
            {routes.length > 0 ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="db-route">Route</label>
                <select id="db-route" className="form-select" value={filters.routeId} onChange={set('routeId')}>
                  <option value="">All routes</option>
                  {routes.map((r) => <option key={r.id} value={r.id}>{r.routeCode}</option>)}
                </select>
              </div>
            ) : null}
            {collectors.length > 0 ? (
              <div className="col-6 col-md-3 col-xl-2">
                <label className="form-label small fw-semibold" htmlFor="db-collector">Collector</label>
                <select id="db-collector" className="form-select" value={filters.collectorId} onChange={set('collectorId')}>
                  <option value="">All collectors</option>
                  {collectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ) : null}
            <div className="col-6 col-md-3 col-xl-2 d-grid">
              <button type="button" className="btn btn-outline-secondary" onClick={() => setFilters(emptyFilters)}>
                <i className="bi bi-arrow-counterclockwise me-1" aria-hidden="true" />Reset
              </button>
            </div>
          </div>
        </div>
      </div>

      {data ? (
        <>
          {/* ---- row 1 ---- */}
          <div className="row g-3 mb-3">
            <div className="col-6 col-xl-3">
              <KpiCard label="Active loans" value={data.loans.activeCount} sub={`${formatCurrency(data.loans.activePrincipal)} principal`} icon="bi-cash-coin" accent="primary" to="/reports/loans" />
            </div>
            <div className="col-6 col-xl-3">
              <KpiCard label="Demand outstanding" value={formatCurrency(data.demand.todayDemand)} period={formatDate(data.demand.asOf)} sub={`${data.demand.demandEmiCount} EMIs`} icon="bi-clipboard-data" accent="warning" to="/demand" />
            </div>
            <div className="col-6 col-xl-3">
              <KpiCard label="Collected today" value={formatCurrency(data.collections.today.postedAmount)} period={formatDate(data.collections.today.date)} sub={`${data.collections.today.postedCount} collections`} icon="bi-cash-stack" accent="success" to="/reports/collections" />
            </div>
            <div className="col-6 col-xl-3">
              <KpiCard label="Due today" value={formatCurrency(data.demand.dueTodayAmount)} sub={`${data.demand.dueTodayCount} EMIs due`} icon="bi-calendar-event" accent="info" to="/demand" />
            </div>
          </div>

          {/* ---- row 2 ---- */}
          <div className="row g-3 mb-4">
            <div className="col-6 col-xl-3">
              <KpiCard label="Overdue amount" value={formatCurrency(data.emi.overdueAmount)} sub={`${data.emi.overdueLoanCount} overdue loan${data.emi.overdueLoanCount === 1 ? '' : 's'}`} icon="bi-exclamation-triangle" accent="danger" to="/reports/emis" />
            </div>
            <div className="col-6 col-xl-3">
              <KpiCard label="Partially paid EMIs" value={data.emi.partialCount} sub="received money, not settled" icon="bi-pie-chart" accent="warning" to="/reports/emis" />
            </div>
            <div className="col-6 col-xl-3">
              <KpiCard label={`Collected (${periodLabel})`} value={formatCurrency(data.collections.period.postedAmount)} sub={`${data.collections.period.postedCount} collections · avg ${formatCurrency(data.collections.period.averageCollection)}`} icon="bi-receipt" accent="success" to="/reports/collections" />
            </div>
            <div className="col-6 col-xl-3">
              <EfficiencyBar percent={data.efficiency.percent} collected={data.efficiency.collected} dueValue={data.efficiency.dueValue} definition={data.efficiency.definition} />
            </div>
          </div>

          {/* ---- route performance ---- */}
          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body">
              <div className="d-flex align-items-center justify-content-between mb-3">
                <h2 className="h5 fw-bold mb-0">Route performance</h2>
                <Link className="btn btn-sm btn-outline-secondary" to="/reports/demand">Demand vs collection</Link>
              </div>
              <div className="table-responsive">
                <table className="table table-sm align-middle mb-0">
                  <thead className="table-light">
                    <tr>
                      <th scope="col">Route</th>
                      <th scope="col">Collectors</th>
                      <th scope="col" className="text-end">Active loans</th>
                      <th scope="col" className="text-end">Due</th>
                      <th scope="col" className="text-end">Collected</th>
                      <th scope="col" className="text-end">Outstanding</th>
                      <th scope="col" className="text-end">Overdue</th>
                      <th scope="col" style={{ minWidth: '9rem' }}>Efficiency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.routes.length === 0 ? (
                      <tr><td colSpan="8" className="text-center text-secondary py-4">No routed loans with instalments due.</td></tr>
                    ) : (
                      data.routes.map((row) => (
                        <tr key={row.route?.id ?? 'unrouted'}>
                          <td>
                            {row.route ? (
                              <>
                                <Link className="font-monospace" to={`/routes/${row.route.id}`}>{row.route.routeCode}</Link>
                                <span className="text-secondary ms-2 small">{row.route.name}</span>
                              </>
                            ) : '—'}
                          </td>
                          <td className="small text-secondary">{row.collectorNames || <span className="badge text-bg-warning">Unassigned</span>}</td>
                          <td className="text-end">{row.activeLoans}</td>
                          <td className="text-end">{formatCurrency(row.dueValue)}</td>
                          <td className="text-end text-success">{formatCurrency(row.collected)}</td>
                          <td className="text-end fw-semibold">{formatCurrency(row.outstanding)}</td>
                          <td className="text-end text-danger">{formatCurrency(row.overdueAmount)}<span className="text-secondary small ms-1">({row.overdueCount})</span></td>
                          <td><EfficiencyBar percent={row.efficiencyPercent} compact /></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ---- collector performance ---- */}
          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body">
              <h2 className="h5 fw-bold mb-3">Collector performance</h2>
              <div className="table-responsive">
                <table className="table table-sm align-middle mb-0">
                  <thead className="table-light">
                    <tr>
                      <th scope="col">Collector</th>
                      <th scope="col">Routes</th>
                      <th scope="col" className="text-end">Active loans</th>
                      <th scope="col" className="text-end">Due</th>
                      <th scope="col" className="text-end">Collected</th>
                      <th scope="col" className="text-end">Outstanding</th>
                      <th scope="col" className="text-end">Overdue</th>
                      <th scope="col" style={{ minWidth: '9rem' }}>Efficiency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.collectors.length === 0 ? (
                      <tr><td colSpan="8" className="text-center text-secondary py-4">No collectors assigned to routes with due instalments.</td></tr>
                    ) : (
                      data.collectors.map((row) => (
                        <tr key={row.collector.id}>
                          <td className="fw-semibold">{row.collector.name}</td>
                          <td className="small text-secondary font-monospace">{row.routes.join(', ') || '—'}</td>
                          <td className="text-end">{row.activeLoans}</td>
                          <td className="text-end">{formatCurrency(row.dueValue)}</td>
                          <td className="text-end text-success">{formatCurrency(row.collected)}</td>
                          <td className="text-end fw-semibold">{formatCurrency(row.outstanding)}</td>
                          <td className="text-end text-danger">{formatCurrency(row.overdueAmount)}<span className="text-secondary small ms-1">({row.overdueCount})</span></td>
                          <td><EfficiencyBar percent={row.efficiencyPercent} compact /></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ---- attention required ---- */}
          <div className="card border-0 shadow-sm">
            <div className="card-body pb-0">
              <h2 className="h5 fw-bold mb-3">Attention required</h2>
            </div>
            <AlertList alerts={data.alerts} />
            <div className="card-body pt-3">
              <p className="form-text mb-0">
                Every item above is a fact drawn from existing loan, EMI and collection data — no risk scoring is applied.
              </p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
