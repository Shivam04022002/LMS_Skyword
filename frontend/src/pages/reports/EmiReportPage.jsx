import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import ReportSummaryCards from '../../components/reports/ReportSummaryCards';
import ReportToolbar from '../../components/reports/ReportToolbar';
import EmiStatusBadge from '../../components/emis/EmiStatusBadge';
import { getEmiReport } from '../../services/reportService';
import { getRoutes } from '../../services/routeService';
import { formatCurrency } from '../../utils/loanConstants';
import { EMI_STATUSES } from '../../utils/emiConstants';
import { REPORTS, DEFAULT_PAGE_SIZE } from '../../utils/reportConstants';
import { today } from '../../utils/today';

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

export default function EmiReportPage() {
  const emptyFilters = { date: today(), status: '', routeId: '', dateFrom: '', dateTo: '', minDpd: '' };
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getRoutes({ limit: 100 }).then((r) => setRoutes(r.data.routes)).catch(() => setRoutes([]));
  }, []);

  useEffect(() => {
    setPage(1);
  }, [filters.date, filters.status, filters.routeId, filters.dateFrom, filters.dateTo, filters.minDpd]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getEmiReport({ ...filters, page, limit: DEFAULT_PAGE_SIZE });
      setData(response.data);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the EMI report.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  const summary = data?.summary;
  const tiles = summary
    ? [
        { key: 'count', label: 'Instalments', value: summary.emiCount, icon: 'bi-list-ol', accent: 'primary' },
        { key: 'emi', label: 'EMI value', value: formatCurrency(summary.totalEmiAmount), icon: 'bi-wallet2', accent: 'primary' },
        { key: 'principal', label: 'Principal', value: formatCurrency(summary.totalPrincipal), icon: 'bi-cash', accent: 'info' },
        { key: 'interest', label: 'Interest', value: formatCurrency(summary.totalInterest), icon: 'bi-percent', accent: 'info' },
        { key: 'collected', label: 'Collected', value: formatCurrency(summary.totalCollected), icon: 'bi-check2-circle', accent: 'success' },
        { key: 'outstanding', label: 'Outstanding', value: formatCurrency(summary.totalOutstanding), icon: 'bi-hourglass-split', accent: 'warning' }
      ]
    : [];

  return (
    <div className="container-fluid px-0">
      <ReportToolbar
        title="EMI report"
        description={`Instalment performance as of ${data?.asOf ?? filters.date}.`}
        reportKey={REPORTS.EMIS}
        exportFormat="xlsx"
        filters={filters}
        loading={loading}
        resultCount={data?.pagination?.total}
        onRefresh={load}
        onReset={() => setFilters(emptyFilters)}
      />

      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="er-date">As of date</label>
              <input id="er-date" type="date" className="form-control" value={filters.date} onChange={set('date')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="er-status">EMI status</label>
              <select id="er-status" className="form-select" value={filters.status} onChange={set('status')}>
                <option value="">All</option>
                {EMI_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="er-route">Route</label>
              <select id="er-route" className="form-select" value={filters.routeId} onChange={set('routeId')}>
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.routeCode}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="er-dpd">Min DPD</label>
              <input id="er-dpd" type="number" min="0" className="form-control" value={filters.minDpd} onChange={set('minDpd')} placeholder="e.g. 30" />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="er-from">Due from</label>
              <input id="er-from" type="date" className="form-control" value={filters.dateFrom} onChange={set('dateFrom')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="er-to">Due to</label>
              <input id="er-to" type="date" className="form-control" value={filters.dateTo} onChange={set('dateTo')} />
            </div>
          </div>
        </div>
      </div>

      {summary ? <div className="mb-4"><ReportSummaryCards tiles={tiles} /></div> : null}

      <div className="card border-0 shadow-sm">
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">Loan</th>
                <th scope="col">Customer</th>
                <th scope="col">#</th>
                <th scope="col">Due date</th>
                <th scope="col" className="text-end">EMI</th>
                <th scope="col" className="text-end">Principal</th>
                <th scope="col" className="text-end">Interest</th>
                <th scope="col" className="text-end">Bounce charge</th>
                <th scope="col" className="text-end">Collected</th>
                <th scope="col" className="text-end">Outstanding</th>
                <th scope="col" className="text-end">DPD</th>
                <th scope="col">Status</th>
                <th scope="col">Route</th>
                <th scope="col">Collector</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="14" className="py-5"><Spinner label="Loading EMI report…" /></td></tr>
              ) : (data?.emis ?? []).length === 0 ? (
                <tr><td colSpan="14" className="text-center text-secondary py-5">No instalments match these filters.</td></tr>
              ) : (
                data.emis.map((emi) => (
                  <tr key={emi.id}>
                    <td className="small">{emi.loan ? <Link className="font-monospace" to={`/loans/${emi.loan.id}`}>{emi.loan.loanNumber}</Link> : '—'}</td>
                    <td>
                      <div className="small fw-semibold">{emi.customer?.fullName ?? '—'}</div>
                      <div className="small text-secondary font-monospace">{emi.customer?.cifId}</div>
                    </td>
                    <td className="fw-semibold">{emi.emiNumber}</td>
                    <td className="small">{formatDate(emi.emiDate)}</td>
                    <td className="text-end">{formatCurrency(emi.emiAmount)}</td>
                    <td className="text-end">{formatCurrency(emi.principal)}</td>
                    <td className="text-end">{formatCurrency(emi.interest)}</td>
                    <td className="text-end text-secondary">{formatCurrency(emi.bounceCharge)}</td>
                    <td className="text-end">{formatCurrency(emi.amountCollected)}</td>
                    <td className="text-end fw-semibold">{formatCurrency(emi.outstanding)}</td>
                    <td className="text-end">{emi.dpd > 0 ? <span className="text-danger fw-semibold">{emi.dpd}</span> : <span className="text-secondary">0</span>}</td>
                    <td><EmiStatusBadge status={emi.status} /></td>
                    <td className="small">{emi.route ? <span className="font-monospace">{emi.route.routeCode}</span> : '—'}</td>
                    <td className="small text-secondary">{emi.collectorNames || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && (data?.emis ?? []).length > 0 ? (
          <div className="card-footer bg-white border-top"><Pagination {...data.pagination} onChange={setPage} /></div>
        ) : null}
      </div>
    </div>
  );
}
