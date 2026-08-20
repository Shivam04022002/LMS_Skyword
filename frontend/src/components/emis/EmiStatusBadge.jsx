import { EMI_STATUS_VARIANTS, EMI_STATUS_ICONS } from '../../utils/emiConstants';

/** Status is derived by the backend from the due date and collected amount. */
export default function EmiStatusBadge({ status }) {
  if (!status) return null;

  return (
    <span className={`badge ${EMI_STATUS_VARIANTS[status] ?? 'text-bg-secondary'}`}>
      <i className={`bi ${EMI_STATUS_ICONS[status] ?? 'bi-circle'} me-1`} aria-hidden="true" />
      {status}
    </span>
  );
}
