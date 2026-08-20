import PartyCard from './PartyCard';
import Spinner from '../common/Spinner';
import usePermissions from '../../hooks/usePermissions';
import { PARTY_ROLES, PARTY_STATUS, partyRoleLabel } from '../../utils/loanPartyConstants';
import { PERMISSIONS } from '../../utils/permissions';

const GROUP_ORDER = [PARTY_ROLES.APPLICANT, PARTY_ROLES.CO_APPLICANT, PARTY_ROLES.GUARANTOR];

/**
 * All parties on a loan, grouped by role. Action buttons are permission-gated;
 * the backend re-checks every call regardless.
 */
export default function PartyList({
  parties = [],
  loading = false,
  error = '',
  onAdd,
  onEdit,
  onRemove,
  onSwap,
  busyPartyId = null
}) {
  const { can } = usePermissions();

  const canCreate = can(PERMISSIONS.LOAN_PARTIES_CREATE);
  const canUpdate = can(PERMISSIONS.LOAN_PARTIES_UPDATE);
  const canRemove = can(PERMISSIONS.LOAN_PARTIES_REMOVE);
  const canSwap = can(PERMISSIONS.LOAN_PARTIES_SWAP);

  if (loading) return <Spinner label="Loading parties…" />;
  if (error) return <div className="alert alert-danger">{error}</div>;

  const active = parties.filter((party) => party.status === PARTY_STATUS.ACTIVE);
  const hasApplicant = active.some((party) => party.partyRole === PARTY_ROLES.APPLICANT);
  const hasCoApplicant = active.some((party) => party.partyRole === PARTY_ROLES.CO_APPLICANT);

  const buildActions = (party) => {
    const buttons = [];
    const isApplicant = party.partyRole === PARTY_ROLES.APPLICANT;

    if (canUpdate && !isApplicant && party.status === PARTY_STATUS.ACTIVE) {
      buttons.push(
        <button type="button" className="btn btn-sm btn-outline-secondary" key="edit" onClick={() => onEdit?.(party)}>
          <i className="bi bi-pencil me-1" aria-hidden="true" />
          Change role
        </button>
      );
    }

    // The applicant has no remove button: a loan must always have one.
    if (canRemove && !isApplicant && party.status === PARTY_STATUS.ACTIVE) {
      buttons.push(
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          key="remove"
          onClick={() => onRemove?.(party)}
          disabled={busyPartyId === party.id}
        >
          <i className="bi bi-x-circle me-1" aria-hidden="true" />
          Remove
        </button>
      );
    }

    return buttons.length > 0 ? buttons : null;
  };

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h2 className="h5 fw-bold mb-0">Loan parties</h2>
        <div className="d-flex gap-2">
          {canSwap && hasApplicant && hasCoApplicant ? (
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={onSwap}>
              <i className="bi bi-arrow-left-right me-1" aria-hidden="true" />
              Swap applicant
            </button>
          ) : null}
          {canCreate ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={onAdd}>
              <i className="bi bi-plus-lg me-1" aria-hidden="true" />
              Add party
            </button>
          ) : null}
        </div>
      </div>

      {!hasApplicant ? (
        <div className="alert alert-warning d-flex align-items-center gap-2">
          <i className="bi bi-exclamation-triangle-fill" aria-hidden="true" />
          This loan has no applicant. Every loan needs exactly one.
        </div>
      ) : null}

      {parties.length === 0 ? (
        <p className="text-secondary">No parties have been added to this loan yet.</p>
      ) : (
        GROUP_ORDER.map((role) => {
          const group = parties.filter((party) => party.partyRole === role);
          if (group.length === 0) return null;

          return (
            <section className="mb-4" key={role}>
              <h3 className="text-uppercase small fw-bold text-secondary mb-2">
                {partyRoleLabel(role)}
                {group.length > 1 ? <span className="ms-2 badge text-bg-light border">{group.length}</span> : null}
              </h3>
              <div className="row g-3">
                {group.map((party) => (
                  <div className="col-12 col-md-6 col-xl-4" key={party.id}>
                    <PartyCard party={party} actions={buildActions(party)} />
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
