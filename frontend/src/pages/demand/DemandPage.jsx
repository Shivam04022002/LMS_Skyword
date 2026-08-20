import { useCallback, useEffect, useState } from 'react';
import AlertMessage from '../../components/common/AlertMessage';
import Pagination from '../../components/common/Pagination';
import DemandTable from '../../components/demand/DemandTable';
import DemandSummary from '../../components/demand/DemandSummary';
import usePermissions from '../../hooks/usePermissions';
import { getDemand, getRouteDemandSummary } from '../../services/demandService';
import { getRoutes } from '../../services/routeService';
import { fetchUsers } from '../../services/userService';
import { PERMISSIONS } from '../../utils/permissions';
import { DEMAND_BUCKETS, demandBucketLabel } from '../../utils/routeConstants';
import { formatCurrency } from '../../utils/loanConstants';
import { today } from '../../utils/today';

const PAGE_SIZE = 50;

/**
 * Day-planning screen.
 *
 * Read-only by construction: it shows what is collectable on a chosen business
 * date and offers no money-moving action. Every amount — including outstanding —
 * comes from the API and is displayed as returned.
 */
export default function DemandPage() {
  const { can } = usePermissions();

  const [date, setDate] = useState(today());
  const [filters, setFilters] = useState({ routeId: '', collectorId: '', bucket: '' });
  const [includeUpcoming, setIncludeUpcoming] = useState(false);
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [routeSummaries, setRouteSummaries] = useState([]);

  const [routes, setRoutes] = useState([]);
  const [collectors, setCollectors] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const canSeeRoutes = can(PERMISSIONS.ROUTES_VIEW);

  // Filter options. A collector only ever receives their own routes here, so the
  // dropdown is naturally scoped by the backend.
  useEffect(() => {
    if (!canSeeRoutes) return;
    getRoutes({ status: 'ACTIVE', limit: 100 })
      .then((response) => setRoutes(response.data.routes))
      .catch(() => setRoutes([]));
  }, [canSeeRoutes]);

  useEffect(() => {
    if (!can(PERMISSIONS.USERS_VIEW)) return;
    fetchUsers({ role: 'COLLECTOR', status: 'ACTIVE', limit: 100 })
      .then((response) => setCollectors(response.data.users))
      .catch(() => setCollectors([]));
  }, [can]);

  useEffect(() => {
    setPage(1);
  }, [date, filters.routeId, filters.collectorId, filters.bucket, includeUpcoming]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getDemand({
        date,
        ...filters,
        includeUpcoming: includeUpcoming ? 'true' : '',
        page,
        limit: PAGE_SIZE
      });
      setRows(response.data.demand);
      setSummary(response.data.summary);
      setPagination(response.data.pagination);

      if (canSeeRoutes) {
        const routeResponse = await getRouteDemandSummary({ date });
        setRouteSummaries(routeResponse.data.routes);
      }
    } catch (requestError) {
      setError(requestError.message || 'Unable to load demand.');
      setRows([]);
      setSummary(null);
      setRouteSummaries([]);
    } finally {
      setLoading(false);
    }
  }, [date, filters, includeUpcoming, page, canSeeRoutes]);

  useEffect(() => {
    load();
  }, [load]);

  const clearFilters = () => {
    setDate(today());
    setFilters({ routeId: '', collectorId: '', bucket: '' });
    setIncludeUpcoming(false);
  };

  return (
    <div className="container-fluid px-0">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">Demand</h1>
        <p className="text-secondary mb-0">
          What is collectable on a chosen date, derived from the EMI schedule and posted collections.
        </p>
      </div>

      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="demand-date">
                Business date
              </label>
              <input
                id="demand-date"
                type="date"
                className="form-control"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>

            <div className="col-6 col-md-3">
              <label className="form-label small fw-semibold" htmlFor="demand-route">
                Route
              </label>
              <select
                id="demand-route"
                className="form-select"
                value={filters.routeId}
                onChange={(event) => setFilters((current) => ({ ...current, routeId: event.target.value }))}
                disabled={!canSeeRoutes}
              >
                <option value="">All routes</option>
                {routes.map((route) => (
                  <option value={route.id} key={route.id}>
                    {route.routeCode} — {route.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-6 col-md-3">
              <label className="form-label small fw-semibold" htmlFor="demand-collector">
                Collector
              </label>
              <select
                id="demand-collector"
                className="form-select"
                value={filters.collectorId}
                onChange={(event) => setFilters((current) => ({ ...current, collectorId: event.target.value }))}
                disabled={collectors.length === 0}
              >
                <option value="">All collectors</option>
                {collectors.map((collector) => (
                  <option value={collector.id} key={collector.id}>
                    {collector.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-6 col-md-2">
              <label className="form-label small fw-semibold" htmlFor="demand-bucket">
                Bucket
              </label>
              <select
                id="demand-bucket"
                className="form-select"
                value={filters.bucket}
                onChange={(event) => setFilters((current) => ({ ...current, bucket: event.target.value }))}
              >
                <option value="">All</option>
                {DEMAND_BUCKETS.map((bucket) => (
                  <option value={bucket} key={bucket}>
                    {demandBucketLabel(bucket)}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-12 col-md-4 col-xl-2 d-flex align-items-center gap-3">
              <div className="form-check mt-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="demand-upcoming"
                  checked={includeUpcoming}
                  onChange={(event) => setIncludeUpcoming(event.target.checked)}
                />
                <label className="form-check-label small" htmlFor="demand-upcoming">
                  Include upcoming
                </label>
              </div>
              <button type="button" className="btn btn-outline-secondary btn-sm mt-2" onClick={clearFilters} title="Reset">
                <i className="bi bi-arrow-counterclockwise" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {summary ? (
        <div className="mb-4">
          <DemandSummary summary={summary} />
        </div>
      ) : null}

      {canSeeRoutes && routeSummaries.length > 0 ? (
        <div className="card border-0 shadow-sm mb-4">
          <div className="card-body">
            <h2 className="h6 fw-bold mb-3">By route</h2>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th scope="col">Route</th>
                    <th scope="col" className="text-end">EMIs</th>
                    <th scope="col" className="text-end">Overdue</th>
                    <th scope="col" className="text-end">Due today</th>
                    <th scope="col" className="text-end">Total demand</th>
                    <th scope="col" className="text-end">Max DPD</th>
                  </tr>
                </thead>
                <tbody>
                  {routeSummaries.map((entry) => (
                    <tr key={entry.route.id}>
                      <td>
                        <span className="font-monospace">{entry.route.routeCode}</span>
                        <span className="text-secondary ms-2">{entry.route.name}</span>
                      </td>
                      <td className="text-end">{entry.emiCount}</td>
                      <td className="text-end">{formatCurrency(entry.overdueAmount)}</td>
                      <td className="text-end">{formatCurrency(entry.dueTodayAmount)}</td>
                      <td className="text-end fw-semibold">{formatCurrency(entry.totalDemand)}</td>
                      <td className="text-end">{entry.maxDpd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card border-0 shadow-sm">
        <DemandTable rows={rows} loading={loading} emptyMessage={`Nothing to collect on ${date}.`} />

        {!loading && rows.length > 0 ? (
          <div className="card-footer bg-white border-top">
            <Pagination {...pagination} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <p className="form-text mt-3">
        Demand is read-only. Outstanding amounts come from the backend&apos;s allocation ledger — payments are recorded
        from the Collections screen.
      </p>
    </div>
  );
}
