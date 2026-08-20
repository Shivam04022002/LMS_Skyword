import { partyRoleLabel } from '../../utils/loanPartyConstants';

const ROLE_VARIANTS = {
  APPLICANT: 'text-bg-primary',
  CO_APPLICANT: 'text-bg-info',
  GUARANTOR: 'text-bg-secondary'
};

const ROLE_ICONS = {
  APPLICANT: 'bi-person-fill',
  CO_APPLICANT: 'bi-person-plus-fill',
  GUARANTOR: 'bi-shield-fill-check'
};

/** Role a customer holds on one loan — not a property of the customer. */
export default function PartyRoleBadge({ role, size = '' }) {
  if (!role) return null;

  return (
    <span className={`badge ${ROLE_VARIANTS[role] ?? 'text-bg-secondary'} ${size === 'lg' ? 'fs-6' : ''}`}>
      <i className={`bi ${ROLE_ICONS[role] ?? 'bi-person'} me-1`} aria-hidden="true" />
      {partyRoleLabel(role).toUpperCase()}
    </span>
  );
}
