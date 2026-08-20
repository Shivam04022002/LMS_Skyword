import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import RouteFormModal from '../../components/routes/RouteFormModal';
import { RouteStatusBadge } from '../../components/routes/RouteStatusBadge';
import usePermissions from '../../hooks/usePermissions';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getRoutes, updateRouteStatus } from '../../services/routeService';
import { PERMISSIONS } from '../../utils/permissions';
import { ROUTE_STATUSES } from '../../utils/routeConstants';

const PAGE_SIZE = 20;

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function RoutesListPage() {
  const { can } = usePermissions();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const [routes, setRoutes] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [formModal, setFormModal] = useState({ open: false, mode: 'create', route: null });

  const debouncedSearch = useDebouncedValue(search, 400);

  const canCreate = can(PERMISSIONS.ROUTES_CREATE);
  const canUpdate = can(PERMISSIONS.ROUTES_UPDATE);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getRoutes({ page, limit: PAGE_SIZE, search: debouncedSearch, status });
      setRoutes(response.data.routes);
      setPagination(response.data.pagination);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load routes.');
      setRoutes([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, status]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggleStatus = async (route) => {
    const nextStatus = route.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setBusyId(route.id);
    setError('');
    try {
      await updateRouteStatus(route.id, nextStatus);
      setNotice(`${route.routeCode} is now ${nextStatus.toLowerCase()}.`);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaved = async ({ mode, route }) => {
    setFormModal({ open: false, mode: 'create', route: null });
    setNotice(mode === 'create' ? `Route ${route.routeCode} created.` : `Route ${route.routeCode} updated.`);
    await load();
  };

  return (
    <div className="container-fluid px-0">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">Routes</h1>
          <p className="text-secondary mb-0">Field collection routes, their collectors and assigned loans.</p>
        </div>
        {canCreate ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormModal({ open: true, mode: 'create', route: null })}>
            <i className="bi bi-plus-lg me-2" aria-hidden="true" />
            New route
          </button>
        ) : null}
      </div>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-12 col-md-6">
              <label className="form-label small fw-semibold" htmlFor="route-search">
                Search
              </label>
              <div className="input-group">
                <span className="input-group-text">
                  <i className="bi bi-search" aria-hidden="true" />
                </span>
                <input
                  id="route-search"
                  className="form-control"
                  placeholder="Search route code or name"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            <div className="col-6 col-md-3">
              <label className="form-label small fw-semibold" htmlFor="route-status-filter">
                Status
              </label>
              <select
                id="route-status-filter"
                className="form-select"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">All</option>
                {ROUTE_STATUSES.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-6 col-md-3 d-grid">
              <button
                type="button"
                className="btn btn-outline-secondary"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                }}
              >
                <i className="bi bi-arrow-counterclockwise me-1" aria-hidden="true" />
                Clear
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">Route code</th>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col" className="text-end">Collectors</th>
                <th scope="col" className="text-end">Loans</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col" className="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-5">
                    <Spinner label="Loading routes…" />
                  </td>
                </tr>
              ) : routes.length === 0 ? (
                <tr>
                  <td colSpan="8" className="text-center text-secondary py-5">
                    No routes found.
                  </td>
                </tr>
              ) : (
                routes.map((route) => (
                  <tr key={route.id} className={route.status === 'INACTIVE' ? 'text-secondary' : undefined}>
                    <td>
                      <span className="badge text-bg-light border font-monospace">{route.routeCode}</span>
                    </td>
                    <td className="fw-semibold">{route.name}</td>
                    <td className="text-break small">{route.description || <span className="text-secondary">—</span>}</td>
                    <td className="text-end">{route.collectorCount}</td>
                    <td className="text-end">{route.loanCount}</td>
                    <td>
                      <RouteStatusBadge status={route.status} />
                    </td>
                    <td className="text-secondary small">{formatDate(route.createdAt)}</td>
                    <td className="text-end">
                      <div className="btn-group btn-group-sm">
                        <Link className="btn btn-outline-secondary" to={`/routes/${route.id}`} title="View">
                          <i className="bi bi-eye" aria-hidden="true" />
                        </Link>
                        {canUpdate ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              title="Edit"
                              onClick={() => setFormModal({ open: true, mode: 'edit', route })}
                            >
                              <i className="bi bi-pencil" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              title={route.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                              onClick={() => handleToggleStatus(route)}
                              disabled={busyId === route.id}
                            >
                              <i
                                className={`bi ${route.status === 'ACTIVE' ? 'bi-slash-circle' : 'bi-check-circle'}`}
                                aria-hidden="true"
                              />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && routes.length > 0 ? (
          <div className="card-footer bg-white border-top">
            <Pagination {...pagination} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <RouteFormModal
        open={formModal.open}
        mode={formModal.mode}
        route={formModal.route}
        onClose={() => setFormModal({ open: false, mode: 'create', route: null })}
        onSaved={handleSaved}
      />
    </div>
  );
}
