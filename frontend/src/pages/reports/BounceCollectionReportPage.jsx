import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import ReportSummaryCards from '../../components/reports/ReportSummaryCards';
import ReportToolbar from '../../components/reports/ReportToolbar';
import CollectionStatusBadge from '../../components/collections/CollectionStatusBadge';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import usePermissions from '../../hooks/usePermissions';
import { getBounceCollectionReport } from '../../services/reportService';
import { getRoutes } from '../../services/routeService';
import { fetchUsers } from '../../services/userService';
import { PERMISSIONS } from '../../utils/permissions';
import { formatCurrency } from '../../utils/loanConstants';
import { COLLECTION_STATUSES, LEDGER_ICONS } from '../../utils/collectionConstants';
import { REPORTS, DEFAULT_PAGE_SIZE } from '../../utils/reportConstants';

const EMPTY = { status: '', routeId: '', collectorId: '', dateFrom: '', dateTo: '', search: '' };

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

/**
 * Bounce Collection.
 *
 * Bounce that was ACTUALLY COLLECTED — the `bounce_amount` component of posted
 * collections. It is never the bounce charge assessed on an instalment
 * (`emi_schedules.bounce_charge`), which says only what is owed.
 *
 * Every figure on this page comes from the backend's bounce-collection report,
 * which is the collection report with `bounce_amount > 0` applied in SQL. There
 * is no bounce arithmetic here and no second definition of the metric: the row
 * fields and the summary are the same ones the Collection report computes, so
 * the two pages cannot disagree.
 */
export default function BounceCollectionReportPage() {
  const { can } = usePermissions();

  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [collectors, setCollectors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const debouncedSearch = useDebouncedValue(filters.search, 400);
  const query = { ...filters, search: debouncedSearch };

  useEffect(() => {
    getRoutes({ limit: 100 }).then((r) => setRoutes(r.data.routes)).catch(() => setRoutes([]));
  }, []);

  // Only fetched where the caller may list users; the backend scopes the report
  // itself regardless of what this control offers.
  useEffect(() => {
    if (!can(PERMISSIONS.USERS_VIEW)) return;
    fetchUsers({ role: 'COLLECTOR', status: 'ACTIVE', limit: 100 })
      .then((r) => setCollectors(r.data.users))
      .catch(() => setCollectors([]));
  }, [can]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filters.status, filters.routeId, filters.collectorId, filters.dateFrom, filters.dateTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getBounceCollectionReport({ ...query, page, limit: DEFAULT_PAGE_SIZE });
      setData(response.data);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the bounce collection report.');
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, filters.status, filters.routeId, filters.collectorId, filters.dateFrom, filters.dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  const summary = data?.summary;
  const tiles = summary
    ? [
        /*
         * The headline. "Collected" is literal: money received against a bounce
         * charge, from POSTED collections only.
         */
        {
          key: 'bounce',
          label: 'Bounce collected',
          value: formatCurrency(summary.collectedBounce),
          sub: 'actually received — not charges assessed',
          icon: 'bi-exclamation-octagon',
          accent: 'warning'
        },
        {
          key: 'count',
          label: 'Bounce collections',
          value: `${summary.bounceCollectionCount} collection${summary.bounceCollectionCount === 1 ? '' : 's'}`,
          sub: 'carried a bounce amount',
          icon: 'bi-hash',
          accent: 'primary'
        },
        {
          key: 'posted',
          label: 'Posted',
          value: summary.postedCount,
          sub: `${formatCurrency(summary.postedAmount)} received`,
          icon: 'bi-check2-circle',
          accent: 'success'
        },
        {
          key: 'reversed',
          label: 'Reversed',
          value: summary.reversedCount,
          sub: `${formatCurrency(summary.reversedBounce ?? '0.00')} bounce — excluded from totals`,
          icon: 'bi-arrow-counterclockwise',
          accent: 'danger'
        },
        {
          key: 'emi',
          label: 'EMI collected with bounce',
          value: formatCurrency(summary.emiCollected),
          sub: 'informational — instalment part of these payments',
          icon: 'bi-calendar-check',
          accent: 'info'
        },
        {
          // Total received = EMI collected + bounce collected, exactly.
          key: 'total',
          label: 'Total received',
          value: formatCurrency(summary.netCollected),
          sub: 'EMI collected + bounce collected',
          icon: 'bi-cash-stack',
          accent: 'success'
        }
      ]
    : [];

  const rows = data?.collections ?? [];

  return (
    <div className="container-fluid px-0">
      <ReportToolbar
        title="Bounce Collection"
        description="Track bounce charges actually collected with EMI payments."
        reportKey={REPORTS.BOUNCE_COLLECTIONS}
        exportFormat="xlsx"
        filters={query}
        loading={loading}
        resultCount={data?.pagination?.total}
        onRefresh={load}
        onReset={() => setFilters(EMPTY)}
      />

      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="alert alert-info d-flex align-items-start gap-2">
        <i className="bi bi-info-circle-fill mt-1" aria-hidden="true" />
        <div>
          <strong>Bounce collected is money received, not money owed.</strong> A collection appears here only when it
          actually carried a bounce amount. A bounce charge recorded against an instalment but never paid is
          <em> bounce outstanding</em>, and does not appear on this page.
        </div>
      </div>

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-12 col-md-4 col-xl-3">
              <label className="form-label small fw-semibold" htmlFor="bc-search">Collection number</label>
              <input
                id="bc-search"
                className="form-control"
                placeholder="Search collection number"
                value={filters.search}
                onChange={set('search')}
              />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="bc-status">Status</label>
              <select id="bc-status" className="form-select" value={filters.status} onChange={set('status')}>
                <option value="">All</option>
                {COLLECTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="bc-route">Route</label>
              <select id="bc-route" className="form-select" value={filters.routeId} onChange={set('routeId')}>
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.routeCode}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="bc-collector">Collector</label>
              <select id="bc-collector" className="form-select" value={filters.collectorId} onChange={set('collectorId')}>
                <option value="">All collectors</option>
                {collectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="bc-from">From</label>
              <input id="bc-from" type="date" className="form-control" value={filters.dateFrom} onChange={set('dateFrom')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="bc-to">To</label>
              <input id="bc-to" type="date" className="form-control" value={filters.dateTo} onChange={set('dateTo')} />
            </div>
          </div>
        </div>
      </div>

      {summary ? <div className="mb-4"><ReportSummaryCards tiles={tiles} /></div> : null}

      <div className="card border-0 shadow-sm">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">Collection</th>
                <th scope="col">Date</th>
                <th scope="col">Loan</th>
                <th scope="col">Customer</th>
                <th scope="col">CIFID</th>
                <th scope="col" className="text-end">Total Received</th>
                <th scope="col" className="text-end">EMI Collected</th>
                <th scope="col" className="text-end">Bounce Collected</th>
                <th scope="col">Ledger</th>
                <th scope="col">Reference</th>
                <th scope="col">Route</th>
                <th scope="col">Collected By</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-end">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="14" className="py-5"><Spinner label="Loading bounce collections…" /></td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan="14" className="text-center text-secondary py-5">
                    <i className="bi bi-inbox fs-2 d-block mb-2" aria-hidden="true" />
                    <div className="fw-semibold text-body mb-1">No bounce collections found</div>
                    <div className="small">
                      Bounce collection appears here only when an actual bounce amount has been collected with a posted
                      collection. Bounce charges that have been assessed but not paid are not shown.
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((c) => (
                  <tr key={c.id} className={c.status === 'REVERSED' ? 'text-secondary' : undefined}>
                    <td>
                      {/* Reuses the existing collection details page. */}
                      <Link className="font-monospace" to={`/collections/${c.id}`}>{c.collectionNumber}</Link>
                    </td>
                    <td className="small">{formatDate(c.collectionDate)}</td>
                    <td className="small font-monospace">{c.loan?.loanNumber ?? '—'}</td>
                    <td className="fw-semibold">{c.customer?.fullName ?? '—'}</td>
                    <td className="small text-secondary font-monospace">{c.customer?.cifId ?? '—'}</td>
                    <td className={`text-end ${c.countsTowardTotals ? '' : 'text-decoration-line-through'}`}>
                      {formatCurrency(c.amount)}
                    </td>
                    <td className="text-end small">{formatCurrency(c.emiCollected)}</td>
                    {/* The point of this page, so it carries the visual weight. */}
                    <td
                      className={`text-end fw-bold ${c.countsTowardTotals ? 'text-warning-emphasis' : 'text-decoration-line-through'}`}
                    >
                      {formatCurrency(c.collectedBounce)}
                    </td>
                    <td className="small">
                      <i className={`bi ${LEDGER_ICONS[c.ledgerType]} me-1`} aria-hidden="true" />
                      {c.ledgerType}
                    </td>
                    <td className="small text-break">{c.paymentReference || '—'}</td>
                    <td className="small">{c.route ? <span className="font-monospace">{c.route.routeCode}</span> : '—'}</td>
                    <td className="small text-secondary">{c.createdBy ?? '—'}</td>
                    <td><CollectionStatusBadge status={c.status} /></td>
                    <td className="text-end">
                      <Link className="btn btn-sm btn-outline-secondary" to={`/collections/${c.id}/receipt`} title="Receipt">
                        <i className="bi bi-printer" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && rows.length > 0 ? (
          <div className="card-footer bg-white border-top"><Pagination {...data.pagination} onChange={setPage} /></div>
        ) : null}
      </div>
    </div>
  );
}
