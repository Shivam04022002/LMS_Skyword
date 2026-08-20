import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import PartyCard from './PartyCard';
import PartySelector from './PartySelector';
import { addLoanParty, updateLoanParty } from '../../services/loanPartyService';
import { PARTY_ROLES, PARTY_ROLE_VALUES, PARTY_STATUS, partyRoleLabel } from '../../utils/loanPartyConstants';

/**
 * Attaches an existing customer to a loan, or changes an existing party's role.
 *
 * The backend owns every rule here — one active applicant per loan, one role per
 * customer per loan, active customers only. This form mirrors those rules so the
 * operator is not offered an option that will be refused, but it never enforces
 * them: the POST/PUT is what decides, and its error message is shown verbatim.
 */
export default function PartyFormModal({ open, mode = 'add', loanId, party = null, parties = [], onClose, onSaved }) {
  const [customer, setCustomer] = useState(null);
  const [partyRole, setPartyRole] = useState(PARTY_ROLES.CO_APPLICANT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const active = parties.filter((item) => item.status === PARTY_STATUS.ACTIVE);
  // The applicant slot is taken by anyone other than the party being edited.
  const applicantTaken = active.some(
    (item) => item.partyRole === PARTY_ROLES.APPLICANT && item.id !== party?.id
  );
  const attachedCustomerIds = active.map((item) => item.customer?.id).filter(Boolean);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSubmitting(false);
    setCustomer(mode === 'edit' ? (party?.customer ?? null) : null);
    setPartyRole(
      mode === 'edit'
        ? (party?.partyRole ?? PARTY_ROLES.CO_APPLICANT)
        : applicantTaken
          ? PARTY_ROLES.CO_APPLICANT
          : PARTY_ROLES.APPLICANT
    );
    // Recomputing on every parties change would discard the operator's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, party]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (mode === 'add' && !customer) {
      setError('Select the customer to attach to this loan.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'edit') {
        await updateLoanParty(loanId, party.id, { partyRole });
      } else {
        // Identify the customer by id — never by profile fields.
        await addLoanParty(loanId, { customerId: customer.id, partyRole });
      }
      await onSaved?.({ mode, partyRole });
    } catch (requestError) {
      // Backend messages are specific (duplicate role, inactive customer,
      // applicant already present) — showing them is more useful than a
      // generic failure notice.
      setError(requestError.message || 'The party could not be saved.');
    } finally {
      setSubmitting(false);
    }
  };

  const roleDisabled = (role) => role === PARTY_ROLES.APPLICANT && applicantTaken;

  return (
    <Modal
      title={mode === 'edit' ? 'Change party role' : 'Add party to loan'}
      open={open}
      onClose={submitting ? () => {} : onClose}
      size="modal-lg"
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="modal-body">
          <AlertMessage message={error} onDismiss={() => setError('')} />

          <div className="mb-4">
            <span className="form-label small fw-semibold d-block">Role on this loan</span>
            {PARTY_ROLE_VALUES.map((role) => (
              <div className="form-check" key={role}>
                <input
                  className="form-check-input"
                  type="radio"
                  name="party-role"
                  id={`party-role-${role}`}
                  value={role}
                  checked={partyRole === role}
                  onChange={() => setPartyRole(role)}
                  disabled={submitting || roleDisabled(role)}
                />
                <label className="form-check-label" htmlFor={`party-role-${role}`}>
                  {partyRoleLabel(role)}
                  {roleDisabled(role) ? (
                    <span className="text-secondary small ms-2">
                      — this loan already has an applicant. Use “Swap applicant” instead.
                    </span>
                  ) : null}
                </label>
              </div>
            ))}
          </div>

          <div>
            <span className="form-label small fw-semibold d-block">Customer</span>
            {mode === 'edit' ? (
              <>
                <div className="row g-2">
                  <div className="col-12 col-md-6">
                    <PartyCard party={{ ...party, partyRole }} compact />
                  </div>
                </div>
                <div className="form-text">
                  The customer on a party cannot be changed — remove the party and add another instead.
                </div>
              </>
            ) : customer ? (
              <div className="row g-2">
                <div className="col-12 col-md-6">
                  <PartyCard
                    party={{ id: customer.id, partyRole, status: PARTY_STATUS.ACTIVE, customer }}
                    compact
                    actions={[
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        key="change"
                        onClick={() => setCustomer(null)}
                        disabled={submitting}
                      >
                        Choose someone else
                      </button>
                    ]}
                  />
                </div>
              </div>
            ) : (
              <PartySelector onSelect={setCustomer} excludeCustomerIds={attachedCustomerIds} autoFocus />
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || (mode === 'add' && !customer)}>
            {submitting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Saving…
              </>
            ) : mode === 'edit' ? (
              'Save role'
            ) : (
              'Add party'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
