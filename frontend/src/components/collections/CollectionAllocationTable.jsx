import EmiStatusBadge from '../emis/EmiStatusBadge';
import { formatCurrency } from '../../utils/loanConstants';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * How one collection was split across instalments. EMI status and outstanding
 * come from the API, which derives them from the allocation ledger.
 */
export default function CollectionAllocationTable({ allocations = [], reversed = false }) {
  if (allocations.length === 0) {
    return <p className="text-secondary mb-0">This collection has no allocations.</p>;
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle mb-0">
        <thead className="table-light">
          <tr>
            <th scope="col">EMI #</th>
            <th scope="col">EMI date</th>
            <th scope="col" className="text-end">EMI amount</th>
            <th scope="col" className="text-end">Allocated</th>
            <th scope="col" className="text-end">Outstanding now</th>
            <th scope="col">EMI status</th>
          </tr>
        </thead>
        <tbody>
          {allocations.map((allocation) => (
            <tr key={allocation.id} className={reversed ? 'text-decoration-line-through text-secondary' : undefined}>
              <td className="fw-semibold">{allocation.emi?.emiNumber ?? '—'}</td>
              <td>{formatDate(allocation.emi?.emiDate)}</td>
              <td className="text-end">{formatCurrency(allocation.emi?.emiAmount)}</td>
              <td className="text-end fw-semibold">{formatCurrency(allocation.allocatedAmount)}</td>
              <td className="text-end">{formatCurrency(allocation.emi?.outstanding)}</td>
              <td>
                <EmiStatusBadge status={allocation.emi?.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {reversed ? (
        <p className="form-text mt-2 mb-0">
          This collection has been reversed — these allocations no longer count towards any instalment balance. They are
          shown for history.
        </p>
      ) : null}
    </div>
  );
}
