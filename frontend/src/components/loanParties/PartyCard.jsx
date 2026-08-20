import PartyRoleBadge from './PartyRoleBadge';
import { PARTY_STATUS } from '../../utils/loanPartyConstants';

/**
 * One party on a loan. Customer details come from the party payload's `customer`
 * object, which the API reads from the customers table — nothing is duplicated
 * into the relationship record, and internal database ids are never shown.
 */
export default function PartyCard({ party, actions = null, compact = false }) {
  if (!party) return null;

  const { customer, partyRole, status } = party;
  const isRemoved = status === PARTY_STATUS.REMOVED;

  return (
    <div className={`card border-0 shadow-sm h-100 ${isRemoved ? 'opacity-75' : ''}`}>
      <div className="card-body">
        <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
          <PartyRoleBadge role={partyRole} />
          {isRemoved ? <span className="badge text-bg-light border">Removed</span> : null}
        </div>

        <p className="fw-semibold mb-1">{customer?.fullName ?? <span className="text-secondary">Unknown customer</span>}</p>

        <dl className="row small mb-0">
          <dt className="col-4 text-secondary fw-normal">CIFID</dt>
          <dd className="col-8 font-monospace mb-1">{customer?.cifId ?? '—'}</dd>

          <dt className="col-4 text-secondary fw-normal">Mobile</dt>
          <dd className="col-8 font-monospace mb-0">{customer?.mobile ?? '—'}</dd>

          {!compact && customer?.status === 'INACTIVE' ? (
            <>
              <dt className="col-4 text-secondary fw-normal">Customer</dt>
              <dd className="col-8 mb-0">
                <span className="badge text-bg-warning">Inactive</span>
              </dd>
            </>
          ) : null}
        </dl>

        {actions ? <div className="d-flex flex-wrap gap-2 mt-3 pt-3 border-top">{actions}</div> : null}
      </div>
    </div>
  );
}
