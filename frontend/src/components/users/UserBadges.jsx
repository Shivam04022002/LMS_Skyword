import { formatRole } from '../../utils/constants';

const ROLE_VARIANTS = {
  SUPER_ADMIN: 'text-bg-dark',
  ADMIN: 'text-bg-primary',
  MANAGER: 'text-bg-info',
  COLLECTOR: 'text-bg-warning',
  STAFF: 'text-bg-secondary'
};

export function RoleBadge({ role }) {
  if (!role) return <span className="text-secondary">—</span>;
  return <span className={`badge ${ROLE_VARIANTS[role] ?? 'text-bg-secondary'}`}>{formatRole(role)}</span>;
}

export function StatusBadge({ status }) {
  const isActive = status === 'ACTIVE';
  return (
    <span className={`badge ${isActive ? 'text-bg-success' : 'text-bg-light border'}`}>
      <i className={`bi ${isActive ? 'bi-check-circle' : 'bi-slash-circle'} me-1`} aria-hidden="true" />
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}
