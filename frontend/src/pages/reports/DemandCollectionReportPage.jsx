import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import ReportSummaryCards from '../../components/reports/ReportSummaryCards';
import ReportToolbar from '../../components/reports/ReportToolbar';
import { getDemandCollectionReport } from '../../services/reportService';
import { getRoutes } from '../../services/routeService';
import { formatCurrency } from '../../utils/loanConstants';
import { REPORTS } from '../../utils/reportConstants';
import { today } from '../../utils/today';

/**
 * Demand vs collection.
 *
 * Demand and money received are presented as separate columns and never added
 * together — demand is what is owed, not what was paid.
 */
export default function DemandCollectionReportPage() {
  const emptyFilters = { date: today(), dateFrom: '', dateTo: '', routeId: '' };
  const [filters, setFilters] = useState(emptyFilters);
  const [data, setData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getRoutes({ limit: 100 }).then((r) => setRoutes(r.data.routes)).catch(() => setRoutes([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getDemandCollectionReport(filters);
      setData(response.data);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the demand report.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  const summary = data?.summary;
  const tiles = summary
    ? [
        { key: 'gross', label: 'Gross demand', value: formatCurrency(summary.grossDemand), sub: `${summary.demandEmiCount} EMIs`, icon: 'bi-clipboard-data', accent: 'primary' },
        { key: 'against', label: 'Already collected', value: formatCurrency(summary.collectedAgainstDemand), sub: 'against those EMIs', icon: 'bi-check2-circle', accent: 'success' },
        { key: 'net', label: 'Net demand outstanding', value: formatCurrency(summary.netDemand), sub: 'still owed', icon: 'bi-hourglass-split', accent: 'warning' },
        { key: 'period', label: 'Collected in period', value: formatCurrency(summary.collectedInPeriod), sub: `${summary.collectionCount} collections`, icon: 'bi-cash-stack', accent: 'success' }
      ]
    : [];

  return (
    <div className="container-fluid px-0">
      <ReportToolbar
        title="Demand vs collection"
        description={`Operational comparison as of ${data?.asOf ?? filters.date}.`}
        reportKey={REPORTS.DEMAND_COLLECTIONS}
        exportFormat="xlsx"
        filters={filters}
        loading={loading}
        resultCount={data?.rows?.length}
        onRefresh={load}
        onReset={() => setFilters(emptyFilters)}
      />

      <AlertMessage message={error} onDismiss={() => setError('')} />

      <div className="alert alert-info d-flex align-items-start gap-2">
        <i className="bi bi-info-circle-fill mt-1" aria-hidden="true" />
        <div>
          <strong>Demand is not money received.</strong> Gross demand is the instalment value collectable on the chosen
          date; “collected in period” is what was actually posted. The two are reported side by side and never summed.
        </div>
      </div>

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-2 align-items-end">
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="dc-date">Demand as of</label>
              <input id="dc-date" type="date" className="form-control" value={filters.date} onChange={set('date')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="dc-from">Collections from</label>
              <input id="dc-from" type="date" className="form-control" value={filters.dateFrom} onChange={set('dateFrom')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="dc-to">Collections to</label>
              <input id="dc-to" type="date" className="form-control" value={filters.dateTo} onChange={set('dateTo')} />
            </div>
            <div className="col-6 col-md-3 col-xl-2">
              <label className="form-label small fw-semibold" htmlFor="dc-route">Route</label>
              <select id="dc-route" className="form-select" value={filters.routeId} onChange={set('routeId')}>
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.routeCode}</option>)}
              </select>
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
                <th scope="col">Route</th>
                <th scope="col">Collectors</th>
                <th scope="col" className="text-end">Demand EMIs</th>
                <th scope="col" className="text-end">Gross demand</th>
                <th scope="col" className="text-end">Already collected</th>
                <th scope="col" className="text-end">Net demand</th>
                <th scope="col" className="text-end">Collections</th>
                <th scope="col" className="text-end">Collected in period</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="8" className="py-5"><Spinner label="Loading demand report…" /></td></tr>
              ) : (data?.rows ?? []).length === 0 ? (
                <tr><td colSpan="8" className="text-center text-secondary py-5">No demand or collections for this date.</td></tr>
              ) : (
                data.rows.map((row) => (
                  <tr key={row.route?.id ?? 'unrouted'}>
                    <td>
                      {row.route ? (
                        <>
                          <Link className="font-monospace" to={`/routes/${row.route.id}`}>{row.route.routeCode}</Link>
                          <span className="text-secondary ms-2 small">{row.route.name}</span>
                        </>
                      ) : (
                        <span className="badge text-bg-light border">Unrouted</span>
                      )}
                    </td>
                    <td className="small text-secondary">{row.collectorNames || '—'}</td>
                    <td className="text-end">{row.demandEmiCount}</td>
                    <td className="text-end">{formatCurrency(row.grossDemand)}</td>
                    <td className="text-end text-success">{formatCurrency(row.collectedAgainstDemand)}</td>
                    <td className="text-end fw-semibold">{formatCurrency(row.netDemand)}</td>
                    <td className="text-end">{row.collectionCount}</td>
                    <td className="text-end text-success fw-semibold">{formatCurrency(row.collectedInPeriod)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
