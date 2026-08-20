import { ROUTE_STATUS_VARIANTS, ASSIGNMENT_STATUS_VARIANTS } from '../../utils/routeConstants';

/** Route status: ACTIVE / INACTIVE. */
export function RouteStatusBadge({ status, size = '' }) {
  if (!status) return null;
  const isActive = status === 'ACTIVE';

  return (
    <span className={`badge ${ROUTE_STATUS_VARIANTS[status] ?? 'text-bg-secondary'} ${size === 'lg' ? 'fs-6' : ''}`}>
      <i className={`bi ${isActive ? 'bi-check-circle' : 'bi-slash-circle'} me-1`} aria-hidden="true" />
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}

/** Assignment status: ACTIVE / REMOVED — a removed row is retained history. */
export function AssignmentStatusBadge({ status }) {
  if (!status) return null;
  const isActive = status === 'ACTIVE';

  return (
    <span className={`badge ${ASSIGNMENT_STATUS_VARIANTS[status] ?? 'text-bg-secondary'}`}>
      <i className={`bi ${isActive ? 'bi-check-circle' : 'bi-clock-history'} me-1`} aria-hidden="true" />
      {isActive ? 'Active' : 'Removed'}
    </span>
  );
}

export default RouteStatusBadge;
