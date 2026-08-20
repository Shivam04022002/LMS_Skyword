import { useCallback, useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import Spinner from '../common/Spinner';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { getLoans } from '../../services/loanService';
import { assignLoan } from '../../services/routeService';
import { formatCurrency } from '../../utils/loanConstants';

/**
 * Assigns a loan to a route.
 *
 * Only ACTIVE loans are offered — closed and cancelled loans are excluded by a
 * server-side status filter rather than a client-side one. A loan already on
 * another route can be moved here; the backend closes the previous assignment
 * and returns 409 only when it is already on *this* route, which is surfaced
 * verbatim.
 */
export default function AssignLoanModal({ open, route, assignedLoanIds = [], onClose, onAssigned }) {
  const [search, setSearch] = useState('');
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getLoans({ status: 'ACTIVE', search: debouncedSearch.trim(), limit: 20 });
      setLoans(response.data.loans);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load loans.');
      setLoans([]);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelected(null);
    setError('');
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const handleAssign = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError('');
    try {
      await assignLoan(route.id, selected.id);
      await onAssigned(`${selected.loanNumber} assigned to ${route.routeCode}`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const selectable = loans.filter((loan) => !assignedLoanIds.includes(loan.id));

  return (
    <Modal
      title={`Assign loan to ${route?.routeCode ?? 'route'}`}
      open={open}
      onClose={submitting ? () => {} : onClose}
      size="modal-lg"
      footer={
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleAssign} disabled={!selected || submitting}>
            {submitting ? 'Assigning…' : selected ? `Assign ${selected.loanNumber}` : 'Assign'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <AlertMessage message={error} onDismiss={() => setError('')} />

        <label className="form-label small fw-semibold" htmlFor="loan-assign-search">
          Find loan
        </label>
        <div className="input-group">
          <span className="input-group-text">
            <i className="bi bi-search" aria-hidden="true" />
          </span>
          <input
            id="loan-assign-search"
            className="form-control"
            placeholder="Search loan number, CIFID, name or mobile"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="form-text">
          Only active loans can be assigned. A loan sits on one route at a time — assigning a loan that is already on
          another route moves it and closes the previous assignment.
        </div>

        <div className="mt-3">
          {loading ? (
            <Spinner label="Loading loans…" size="sm" />
          ) : selectable.length === 0 ? (
            <p className="text-secondary mb-0">
              {loans.length === 0 ? 'No active loans found.' : 'Every matching loan is already on this route.'}
            </p>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th scope="col">Loan</th>
                    <th scope="col">Applicant</th>
                    <th scope="col" className="text-end">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="text-end">Select</th>
                  </tr>
                </thead>
                <tbody>
                  {selectable.map((loan) => (
                    <tr key={loan.id} className={selected?.id === loan.id ? 'table-primary' : undefined}>
                      <td>
                        <span className="badge text-bg-light border font-monospace">{loan.loanNumber}</span>
                      </td>
                      <td>
                        <div className="fw-semibold">{loan.applicant?.fullName ?? '—'}</div>
                        <div className="small text-secondary font-monospace">{loan.applicant?.cifId}</div>
                      </td>
                      <td className="text-end">{formatCurrency(loan.loanAmount)}</td>
                      <td>
                        <span className="badge text-bg-success">{loan.status}</span>
                      </td>
                      <td className="text-end">
                        <button
                          type="button"
                          className={`btn btn-sm ${selected?.id === loan.id ? 'btn-primary' : 'btn-outline-primary'}`}
                          onClick={() => setSelected(loan)}
                          disabled={submitting}
                        >
                          {selected?.id === loan.id ? 'Selected' : 'Select'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selected ? (
          <div className="alert alert-info mt-3 mb-0 d-flex align-items-start gap-2">
            <i className="bi bi-question-circle-fill mt-1" aria-hidden="true" />
            <div>
              Assign loan <strong>{selected.loanNumber}</strong> to route <strong>{route?.name}</strong> (
              {route?.routeCode})?
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
