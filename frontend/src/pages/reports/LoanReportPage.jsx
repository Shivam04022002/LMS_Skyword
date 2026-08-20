import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Pagination from '../../components/common/Pagination';
import ReportSummaryCards from '../../components/reports/ReportSummaryCards';
import ReportToolbar from '../../components/reports/ReportToolbar';
import LoanStatusBadge from '../../components/loans/LoanStatusBadge';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getLoanReport } from '../../services/reportService';
import { getRoutes } from '../../services/routeService';
import { formatCurrency, LOAN_STATUSES, LOAN_TYPES, titleCase } from '../../utils/loanConstants';
import { REPORTS, DEFAULT_PAGE_SIZE } from '../../utils/reportConstants';

const EMPTY = { status: '', loanType: '', routeId: '', dateFrom: '', dateTo: '', search: '' };

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

export default function LoanReportPage() {
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
  }, [debouncedSearch, filters.status, filters.loanType, filters.routeId, filters.dateFrom, filters.dateTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getLoanReport({ ...query, page, limit: DEFAULT_PAGE_SIZE });
      setData(response.data);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the loan report.');
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, filters.status, filters.loanType, filters.routeId, filters.dateFrom, filters.dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  const summary = data?.summary;
  const tiles = summary
    ? [
        { key: 'count', label: 'Loans', value: summary.loanCount, icon: 'bi-cash-coin', accent: 'primary' },
        { key: 'amount', label: 'Loan amount', value: formatCurrency(summary.totalLoanAmount), icon: 'bi-cash', accent: 'primary' },
        { key: 'repay', label: 'Total repayment', value: formatCurrency(summary.totalRepayment), icon: 'bi-wallet2', accent: 'info' },
        { key: 'collected', label: 'Collected', value: formatCurrency(summary.totalCollected), icon: 'bi-check2-circle', accent: 'success' },
        { key: 'outstanding', label: 'Outstanding', value: formatCurrency(summary.totalOutstanding), icon: 'bi-hourglass-split', accent: 'warning' }
      ]
    : [];

  return (
    <div className="container-fluid px-0">
      <ReportToolbar
        title="Loan report"
        description="All loans with their repayment position."
        reportKey={REPORTS.LOANS}
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
              <label className="form-label small fw-semibold" htmlFor="lr-search">Loan number</label>
              <input id="lr-search" className="form-control" placeholder="Search loan number" value={filters.search} onChange={set('search')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="lr-status">Status</label>
              <select id="lr-status" className="form-select" value={filters.status} onChange={set('status')}>
                <option value="">All</option>
                {LOAN_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="lr-type">Loan type</label>
              <select id="lr-type" className="form-select" value={filters.loanType} onChange={set('loanType')}>
                <option value="">All</option>
                {LOAN_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="lr-route">Route</label>
              <select id="lr-route" className="form-select" value={filters.routeId} onChange={set('routeId')}>
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.routeCode}</option>)}
              </select>
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="lr-from">Start from</label>
              <input id="lr-from" type="date" className="form-control" value={filters.dateFrom} onChange={set('dateFrom')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="lr-to">Start to</label>
              <input id="lr-to" type="date" className="form-control" value={filters.dateTo} onChange={set('dateTo')} />
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
                <th scope="col">Loan</th>
                <th scope="col">Applicant</th>
                <th scope="col" className="text-end">Amount</th>
                <th scope="col" className="text-end">ROI</th>
                <th scope="col" className="text-end">Tenure</th>
                <th scope="col" className="text-end">Repayment</th>
                <th scope="col" className="text-end">Collected</th>
                <th scope="col" className="text-end">Outstanding</th>
                <th scope="col">Route</th>
                <th scope="col">Collector</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="12" className="py-5"><Spinner label="Loading loan report…" /></td></tr>
              ) : (data?.loans ?? []).length === 0 ? (
                <tr><td colSpan="12" className="text-center text-secondary py-5">No loans match these filters.</td></tr>
              ) : (
                data.loans.map((loan) => (
                  <tr key={loan.id}>
                    <td><Link className="font-monospace" to={`/loans/${loan.id}`}>{loan.loanNumber}</Link></td>
                    <td>
                      <div className="fw-semibold">{loan.customer?.fullName ?? '—'}</div>
                      <div className="small text-secondary font-monospace">{loan.customer?.cifId}</div>
                    </td>
                    <td className="text-end">{formatCurrency(loan.loanAmount)}</td>
                    <td className="text-end">
                      {Number(loan.roi)}%
                      <span className="text-secondary small ms-1">{loan.roiBasis === 'ANNUAL' ? '/yr' : '/mo'}</span>
                    </td>
                    <td className="text-end">{loan.tenure}</td>
                    <td className="text-end">{formatCurrency(loan.totalRepayment)}</td>
                    <td className="text-end">{formatCurrency(loan.collected)}</td>
                    <td className="text-end fw-semibold">{formatCurrency(loan.outstanding)}</td>
                    <td className="small">{loan.route ? <Link className="font-monospace" to={`/routes/${loan.route.id}`}>{loan.route.routeCode}</Link> : <span className="badge text-bg-light border">Unrouted</span>}</td>
                    <td className="small text-secondary">{loan.collectorNames || '—'}</td>
                    <td><LoanStatusBadge status={loan.status} /></td>
                    <td className="small text-secondary">{formatDate(loan.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && (data?.loans ?? []).length > 0 ? (
          <div className="card-footer bg-white border-top"><Pagination {...data.pagination} onChange={setPage} /></div>
        ) : null}
      </div>
    </div>
  );
}
