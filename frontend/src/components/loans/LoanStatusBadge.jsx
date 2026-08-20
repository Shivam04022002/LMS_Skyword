const STATUS_VARIANTS = {
  DRAFT: 'text-bg-secondary',
  ACTIVE: 'text-bg-success',
  CLOSED: 'text-bg-dark',
  CANCELLED: 'text-bg-light border'
};

const STATUS_ICONS = {
  DRAFT: 'bi-pencil-square',
  ACTIVE: 'bi-play-circle',
  CLOSED: 'bi-check2-circle',
  CANCELLED: 'bi-x-circle'
};

export default function LoanStatusBadge({ status, size = '' }) {
  if (!status) return null;

  return (
    <span className={`badge ${STATUS_VARIANTS[status] ?? 'text-bg-secondary'} ${size === 'lg' ? 'fs-6' : ''}`}>
      <i className={`bi ${STATUS_ICONS[status] ?? 'bi-circle'} me-1`} aria-hidden="true" />
      {status}
    </span>
  );
}
