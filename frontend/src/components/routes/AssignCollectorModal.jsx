import { useCallback, useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import Spinner from '../common/Spinner';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { fetchUsers } from '../../services/userService';
import { assignCollector } from '../../services/routeService';
import { formatRole } from '../../utils/constants';

/**
 * Assigns a collector to a route.
 *
 * The picker asks the API for ACTIVE users with the COLLECTOR role only, so
 * ineligible users are never offered. The backend re-checks both conditions and
 * remains authoritative — its 400/409 responses are surfaced verbatim.
 */
export default function AssignCollectorModal({ open, route, assignedUserIds = [], onClose, onAssigned }) {
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Eligibility is expressed as a server-side filter, not a client filter.
      const response = await fetchUsers({ role: 'COLLECTOR', status: 'ACTIVE', search: debouncedSearch.trim(), limit: 20 });
      setCandidates(response.data.users);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load collectors.');
      setCandidates([]);
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
      await assignCollector(route.id, selected.id);
      await onAssigned(`${selected.name} assigned to ${route.routeCode}`);
    } catch (requestError) {
      // 400 (wrong role) and 409 (inactive / duplicate) carry useful messages.
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const selectable = candidates.filter((candidate) => !assignedUserIds.includes(candidate.id));

  return (
    <Modal
      title={`Assign collector to ${route?.routeCode ?? 'route'}`}
      open={open}
      onClose={submitting ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleAssign} disabled={!selected || submitting}>
            {submitting ? 'Assigning…' : selected ? `Assign ${selected.name}` : 'Assign'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <AlertMessage message={error} onDismiss={() => setError('')} />

        <label className="form-label small fw-semibold" htmlFor="collector-search">
          Find collector
        </label>
        <div className="input-group">
          <span className="input-group-text">
            <i className="bi bi-search" aria-hidden="true" />
          </span>
          <input
            id="collector-search"
            className="form-control"
            placeholder="Search name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="form-text">Only active users with the COLLECTOR role can be assigned.</div>

        <div className="mt-3">
          {loading ? (
            <Spinner label="Loading collectors…" size="sm" />
          ) : selectable.length === 0 ? (
            <p className="text-secondary mb-0">
              {candidates.length === 0
                ? 'No active collectors found.'
                : 'Every matching collector is already assigned to this route.'}
            </p>
          ) : (
            <ul className="list-group">
              {selectable.map((candidate) => (
                <li
                  key={candidate.id}
                  className={`list-group-item d-flex align-items-center justify-content-between gap-3${
                    selected?.id === candidate.id ? ' active' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="fw-semibold">{candidate.name}</div>
                    <div className={`small ${selected?.id === candidate.id ? 'text-white-50' : 'text-secondary'}`}>
                      <span className="text-break">{candidate.email}</span>
                      <span className="mx-2">·</span>
                      {formatRole(candidate.role)}
                      <span className="mx-2">·</span>
                      {candidate.status}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`btn btn-sm flex-shrink-0 ${selected?.id === candidate.id ? 'btn-light' : 'btn-outline-primary'}`}
                    onClick={() => setSelected(candidate)}
                    disabled={submitting}
                  >
                    {selected?.id === candidate.id ? 'Selected' : 'Select'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected ? (
          <div className="alert alert-info mt-3 mb-0 d-flex align-items-start gap-2">
            <i className="bi bi-question-circle-fill mt-1" aria-hidden="true" />
            <div>
              Assign <strong>{selected.name}</strong> to route <strong>{route?.name}</strong> ({route?.routeCode})?
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
