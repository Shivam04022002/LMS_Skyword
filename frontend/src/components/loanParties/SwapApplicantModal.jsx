import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import PartyCard from './PartyCard';
import { swapApplicant } from '../../services/loanPartyService';
import { PARTY_ROLES, PARTY_STATUS } from '../../utils/loanPartyConstants';

/**
 * Confirms and performs an applicant / co-applicant swap.
 *
 * The exchange is a single backend call inside one transaction — never two
 * requests — so the loan can never be observed with two applicants or none.
 * On success the parent reloads from the API rather than mutating local state,
 * keeping the backend authoritative.
 */
export default function SwapApplicantModal({ open, loanId, parties = [], onClose, onSwapped }) {
  const [selectedId, setSelectedId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const active = parties.filter((party) => party.status === PARTY_STATUS.ACTIVE);
  const applicant = active.find((party) => party.partyRole === PARTY_ROLES.APPLICANT) ?? null;
  const coApplicants = active.filter((party) => party.partyRole === PARTY_ROLES.CO_APPLICANT);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSubmitting(false);
    setSelectedId(coApplicants.length === 1 ? coApplicants[0].id : null);
    // Re-running on every parties change would fight the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = coApplicants.find((party) => party.id === selectedId) ?? null;

  const handleSwap = async () => {
    setSubmitting(true);
    setError('');
    try {
      await swapApplicant(loanId, selectedId ?? undefined);
      await onSwapped?.();
    } catch (requestError) {
      setError(requestError.message || 'The swap could not be completed.');
    } finally {
      setSubmitting(false);
    }
  };

  const canSwap = Boolean(applicant) && Boolean(selected) && !submitting;

  return (
    <Modal title="Swap applicant and co-applicant" open={open} onClose={submitting ? () => {} : onClose} size="modal-lg">
      <div className="modal-body">
        <AlertMessage message={error} onDismiss={() => setError('')} />

        {!applicant || coApplicants.length === 0 ? (
          <p className="text-secondary mb-0">
            A swap needs one applicant and at least one co-applicant on this loan.
          </p>
        ) : (
          <>
            <p className="text-secondary">
              The applicant becomes a co-applicant and the selected co-applicant becomes the applicant. This happens in a
              single transaction — the loan is never left with two applicants or none.
            </p>

            {coApplicants.length > 1 ? (
              <div className="mb-3">
                <label className="form-label small fw-semibold" htmlFor="swap-target">
                  Co-applicant to promote
                </label>
                <select
                  id="swap-target"
                  className="form-select"
                  value={selectedId ?? ''}
                  onChange={(event) => setSelectedId(Number(event.target.value) || null)}
                  disabled={submitting}
                >
                  <option value="">Select a co-applicant…</option>
                  {coApplicants.map((party) => (
                    <option value={party.id} key={party.id}>
                      {party.customer?.fullName} ({party.customer?.cifId})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="row g-3 align-items-center">
              <div className="col-12 col-md-5">
                <p className="small text-secondary mb-2">Current applicant</p>
                <PartyCard party={applicant} compact />
              </div>
              <div className="col-12 col-md-2 text-center">
                <i className="bi bi-arrow-left-right fs-3 text-primary" aria-hidden="true" />
                <span className="visually-hidden">will be swapped with</span>
              </div>
              <div className="col-12 col-md-5">
                <p className="small text-secondary mb-2">Becomes applicant</p>
                {selected ? (
                  <PartyCard party={selected} compact />
                ) : (
                  <div className="border rounded p-3 text-secondary text-center">Select a co-applicant</div>
                )}
              </div>
            </div>

            <div className="alert alert-warning mt-3 mb-0 d-flex align-items-start gap-2">
              <i className="bi bi-exclamation-triangle-fill mt-1" aria-hidden="true" />
              <div>Are you sure you want to swap the Applicant and Co-Applicant roles?</div>
            </div>
          </>
        )}
      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSwap} disabled={!canSwap}>
          {submitting ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
              Swapping…
            </>
          ) : (
            'Confirm swap'
          )}
        </button>
      </div>
    </Modal>
  );
}
