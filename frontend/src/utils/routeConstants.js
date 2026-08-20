/** Mirrors backend/src/config/routes.js. */
export const ROUTE_STATUSES = ['ACTIVE', 'INACTIVE'];

export const ASSIGNMENT_STATUSES = ['ACTIVE', 'REMOVED'];

/** Exactly the bucket values the demand API returns and accepts. */
export const DEMAND_BUCKETS = ['OVERDUE', 'DUE_TODAY', 'UPCOMING'];

export const ROUTE_STATUS_VARIANTS = Object.freeze({
  ACTIVE: 'text-bg-success',
  INACTIVE: 'text-bg-light border'
});

export const ASSIGNMENT_STATUS_VARIANTS = Object.freeze({
  ACTIVE: 'text-bg-success',
  REMOVED: 'text-bg-light border'
});

/** Overdue reads as danger, due-today as the primary call to action. */
export const DEMAND_BUCKET_VARIANTS = Object.freeze({
  OVERDUE: 'text-bg-danger',
  DUE_TODAY: 'text-bg-primary',
  UPCOMING: 'text-bg-secondary'
});

export const DEMAND_BUCKET_ICONS = Object.freeze({
  OVERDUE: 'bi-exclamation-triangle',
  DUE_TODAY: 'bi-calendar-event',
  UPCOMING: 'bi-hourglass'
});

export const DEMAND_BUCKET_LABELS = Object.freeze({
  OVERDUE: 'Overdue',
  DUE_TODAY: 'Due today',
  UPCOMING: 'Upcoming'
});

export const demandBucketLabel = (bucket) => DEMAND_BUCKET_LABELS[bucket] ?? bucket ?? '';
