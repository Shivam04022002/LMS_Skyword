import { COLLECTION_STATUS_VARIANTS } from '../../utils/collectionConstants';

export default function CollectionStatusBadge({ status, size = '' }) {
  if (!status) return null;

  const isReversed = status === 'REVERSED';

  return (
    <span className={`badge ${COLLECTION_STATUS_VARIANTS[status] ?? 'text-bg-secondary'} ${size === 'lg' ? 'fs-6' : ''}`}>
      <i className={`bi ${isReversed ? 'bi-arrow-counterclockwise' : 'bi-check2-circle'} me-1`} aria-hidden="true" />
      {status}
    </span>
  );
}
