const ICONS = {
  danger: 'bi-exclamation-triangle-fill',
  warning: 'bi-exclamation-circle-fill',
  success: 'bi-check-circle-fill',
  info: 'bi-info-circle-fill'
};

/** Inline feedback block used for API and validation errors across the app. */
export default function AlertMessage({ variant = 'danger', message, onDismiss }) {
  if (!message) return null;

  return (
    <div className={`alert alert-${variant} d-flex align-items-start gap-2 ${onDismiss ? 'alert-dismissible' : ''}`} role="alert">
      <i className={`bi ${ICONS[variant] ?? ICONS.info} mt-1`} aria-hidden="true" />
      <div className="flex-grow-1">{message}</div>
      {onDismiss ? <button type="button" className="btn-close" aria-label="Dismiss" onClick={onDismiss} /> : null}
    </div>
  );
}
