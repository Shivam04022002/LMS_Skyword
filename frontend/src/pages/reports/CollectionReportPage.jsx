import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import ReportSummaryCards from '../../components/reports/ReportSummaryCards';
import ReportToolbar from '../../components/reports/ReportToolbar';
import CollectionStatusBadge from '../../components/collections/CollectionStatusBadge';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getCollectionReport } from '../../services/reportService';
import { getRoutes } from '../../services/routeService';
import { formatCurrency } from '../../utils/loanConstants';
import { LEDGER_TYPES, COLLECTION_STATUSES, LEDGER_ICONS } from '../../utils/collectionConstants';
import { REPORTS, DEFAULT_PAGE_SIZE } from '../../utils/reportConstants';

const EMPTY = { status: '', ledgerType: '', routeId: '', dateFrom: '', dateTo: '', search: '' };

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

export default function CollectionReportPage() {
  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const debouncedSearch = useDebouncedValue(filters.search, 400);
  const query = { ...filters, search: debouncedSearch };

  useEffect(() => {
    getRoutes({ limit: 100 }).then((r) => setRoutes(r.data.routes)).catch(() => setRoutes([]));
  }, []);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filters.status, filters.ledgerType, filters.routeId, filters.dateFrom, filters.dateTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getCollectionReport({ ...query, page, limit: DEFAULT_PAGE_SIZE });
      setData(response.data);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the collection report.');
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, filters.status, filters.ledgerType, filters.routeId, filters.dateFrom, filters.dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  const summary = data?.summary;
  const tiles = summary
    ? [
        { key: 'net', label: 'Net collected', value: formatCurrency(summary.netCollected), sub: 'POSTED only', icon: 'bi-cash-stack', accent: 'success' },
        // Net collected, split by what the money was applied to. Principal and
        // interest add back up to it exactly; bounce is a memo figure and is in
        // neither of them.
        { key: 'principal', label: 'Collected principal', value: formatCurrency(summary.collectedPrincipal), sub: 'part of net collected', icon: 'bi-cash-coin', accent: 'primary' },
        { key: 'interest', label: 'Collected interest', value: formatCurrency(summary.collectedInterest), sub: 'part of net collected', icon: 'bi-percent', accent: 'info' },
        { key: 'bounce', label: 'Collected bounce', value: formatCurrency(summary.collectedBounce), sub: 'separate — not in net collected', icon: 'bi-exclamation-octagon', accent: 'warning' },
        { key: 'posted', label: 'Posted', value: summary.postedCount, sub: formatCurrency(summary.postedAmount), icon: 'bi-check2-circle', accent: 'success' },
        { key: 'reversed', label: 'Reversed', value: summary.reversedCount, sub: `${formatCurrency(summary.reversedAmount)} — excluded`, icon: 'bi-arrow-counterclockwise', accent: 'danger' },
        { key: 'total', label: 'Records', value: summary.totalCount, icon: 'bi-receipt', accent: 'info' }
      ]
    : [];

  return (
    <div className="container-fluid px-0">
      <ReportToolbar
        title="Collection report"
        description="Money received. Reversed collections stay visible but never count toward totals."
        reportKey={REPORTS.COLLECTIONS}
        exportFormat="xlsx"
        filters={query}
        loading={loading}
        resultCount={data?.pagination?.total}
        onRefresh={load}
        onReset={() => setFilters(EMPTY)}
      />

      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-12 col-md-4 col-xl-3">
              <label className="form-label small fw-semibold" htmlFor="cr-search">Collection number</label>
              <input id="cr-search" className="form-control" placeholder="Search collection number" value={filters.search} onChange={set('search')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="cr-status">Status</label>
              <select id="cr-status" className="form-select" value={filters.status} onChange={set('status')}>
                <option value="">All</option>
                {COLLECTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="cr-ledger">Ledger</label>
              <select id="cr-ledger" className="form-select" value={filters.ledgerType} onChange={set('ledgerType')}>
                <option value="">All</option>
                {LEDGER_TYPES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="cr-route">Route</label>
              <select id="cr-route" className="form-select" value={filters.routeId} onChange={set('routeId')}>
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.routeCode}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="cr-from">From</label>
              <input id="cr-from" type="date" className="form-control" value={filters.dateFrom} onChange={set('dateFrom')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="cr-to">To</label>
              <input id="cr-to" type="date" className="form-control" value={filters.dateTo} onChange={set('dateTo')} />
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
                <th scope="col" className="text-end">Amount</th>
                <th scope="col" className="text-end">Principal</th>
                <th scope="col" className="text-end">Interest</th>
                <th scope="col" className="text-end">Bounce</th>
                <th scope="col">Ledger</th>
                <th scope="col">Reference</th>
                <th scope="col">Route</th>
                <th scope="col">Collected by</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-end">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="14" className="py-5"><Spinner label="Loading collection report…" /></td></tr>
              ) : (data?.collections ?? []).length === 0 ? (
                <tr><td colSpan="14" className="text-center text-secondary py-5">No collections match these filters.</td></tr>
              ) : (
                data.collections.map((c) => (
                  <tr key={c.id} className={c.status === 'REVERSED' ? 'text-secondary' : undefined}>
                    <td><Link className="font-monospace" to={`/collections/${c.id}`}>{c.collectionNumber}</Link></td>
                    <td className="small">{formatDate(c.collectionDate)}</td>
                    <td className="small font-monospace">{c.loan?.loanNumber ?? '—'}</td>
                    <td>
                      <div className="fw-semibold">{c.customer?.fullName ?? '—'}</div>
                      <div className="small text-secondary font-monospace">{c.customer?.cifId}</div>
                    </td>
                    <td className={`text-end ${c.countsTowardTotals ? 'fw-semibold' : 'text-decoration-line-through'}`}>
                      {formatCurrency(c.amount)}
                    </td>
                    <td className="text-end small">{formatCurrency(c.collectedPrincipal)}</td>
                    <td className="text-end small">{formatCurrency(c.collectedInterest)}</td>
                    <td className="text-end small text-secondary">{formatCurrency(c.collectedBounce)}</td>
                    <td className="small"><i className={`bi ${LEDGER_ICONS[c.ledgerType]} me-1`} aria-hidden="true" />{c.ledgerType}</td>
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

        {!loading && (data?.collections ?? []).length > 0 ? (
          <div className="card-footer bg-white border-top"><Pagination {...data.pagination} onChange={setPage} /></div>
        ) : null}
      </div>
    </div>
  );
}
