import { DEMAND_BUCKET_VARIANTS, DEMAND_BUCKET_ICONS, demandBucketLabel } from '../../utils/routeConstants';

/** OVERDUE / DUE_TODAY / UPCOMING — the exact buckets the API returns. */
export default function DemandBucketBadge({ bucket }) {
  if (!bucket) return null;

  return (
    <span className={`badge ${DEMAND_BUCKET_VARIANTS[bucket] ?? 'text-bg-secondary'}`}>
      <i className={`bi ${DEMAND_BUCKET_ICONS[bucket] ?? 'bi-circle'} me-1`} aria-hidden="true" />
      {demandBucketLabel(bucket)}
    </span>
  );
}
