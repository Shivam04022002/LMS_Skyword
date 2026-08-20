import { Link } from 'react-router-dom';
import Spinner from '../common/Spinner';
import DemandBucketBadge from './DemandBucketBadge';
import EmiStatusBadge from '../emis/EmiStatusBadge';
import { formatCurrency } from '../../utils/loanConstants';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Read-only demand table.
 *
 * `demandAmount` is the backend's outstanding figure and is displayed as given —
 * it is never recomputed here from EMI amount minus collected. There are no
 * money-moving actions on this screen: collections are posted from the
 * Collections module.
 */
export default function DemandTable({ rows = [], loading = false, emptyMessage = 'No demand for this date.' }) {
  if (loading) return <Spinner label="Loading demand…" />;

  if (rows.length === 0) {
    return (
      <div className="text-center text-secondary py-5">
        <i className="bi bi-check2-circle fs-3 d-block mb-2" aria-hidden="true" />
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="table-responsive">
      <table className="table align-middle mb-0">
        <thead className="table-light">
          <tr>
            <th scope="col">EMI</th>
            <th scope="col">Loan</th>
            <th scope="col">Customer</th>
            <th scope="col">Route</th>
            <th scope="col">Collector</th>
            <th scope="col">Due date</th>
            <th scope="col" className="text-end">EMI amount</th>
            <th scope="col" className="text-end">Collected</th>
            <th scope="col" className="text-end">Outstanding</th>
            <th scope="col" className="text-end">DPD</th>
            <th scope="col">Bucket</th>
            <th scope="col">EMI status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.emiId} className={row.bucket === 'OVERDUE' ? 'table-danger-subtle' : undefined}>
              <td className="fw-semibold">#{row.emiNumber}</td>
              <td>
                {row.loan ? (
                  <Link className="font-monospace" to={`/loans/${row.loan.id}`}>
                    {row.loan.loanNumber}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>
                <div className="fw-semibold">{row.customer?.fullName ?? '—'}</div>
                <div className="small text-secondary font-monospace">{row.customer?.cifId}</div>
              </td>
              <td>
                {row.route ? (
                  <Link className="small" to={`/routes/${row.route.id}`}>
                    <span className="font-monospace">{row.route.routeCode}</span>
                  </Link>
                ) : (
                  <span className="badge text-bg-light border">Unrouted</span>
                )}
              </td>
              <td className="small text-secondary">
                {row.collectors?.length ? row.collectors.map((c) => c.name).join(', ') : <span className="text-secondary">—</span>}
              </td>
              <td className="small">{formatDate(row.emiDate)}</td>
              <td className="text-end">{formatCurrency(row.emiAmount)}</td>
              <td className="text-end">{formatCurrency(row.amountCollected)}</td>
              <td className="text-end fw-semibold">{formatCurrency(row.demandAmount)}</td>
              <td className="text-end">
                {row.dpd > 0 ? <span className="text-danger fw-semibold">{row.dpd}</span> : <span className="text-secondary">0</span>}
              </td>
              <td>
                <DemandBucketBadge bucket={row.bucket} />
              </td>
              <td>
                <EmiStatusBadge status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
