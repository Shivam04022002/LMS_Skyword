/** Mirrors backend/src/config/emis.js. */
export const EMI_STATUSES = ['PENDING', 'DUE', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED'];

/** Reuses the Bootstrap contextual palette already used by loan and user badges. */
export const EMI_STATUS_VARIANTS = Object.freeze({
  PENDING: 'text-bg-secondary',
  DUE: 'text-bg-primary',
  PARTIAL: 'text-bg-warning',
  PAID: 'text-bg-success',
  OVERDUE: 'text-bg-danger',
  WAIVED: 'text-bg-light border'
});

export const EMI_STATUS_ICONS = Object.freeze({
  PENDING: 'bi-hourglass',
  DUE: 'bi-calendar-event',
  PARTIAL: 'bi-pie-chart',
  PAID: 'bi-check2-circle',
  OVERDUE: 'bi-exclamation-triangle',
  WAIVED: 'bi-slash-circle'
});
