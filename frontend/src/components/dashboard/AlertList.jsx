import { Link } from 'react-router-dom';

const SEVERITY_STYLES = {
  CRITICAL: { border: 'border-danger', icon: 'bi-exclamation-octagon-fill', text: 'text-danger' },
  WARNING: { border: 'border-warning', icon: 'bi-exclamation-triangle-fill', text: 'text-warning' },
  INFO: { border: 'border-info', icon: 'bi-info-circle-fill', text: 'text-info' }
};

/**
 * Attention items.
 *
 * Each entry is a fact supplied by the API with its own destination link — the
 * component invents nothing and ranks nothing beyond the severity the backend
 * assigned.
 */
export default function AlertList({ alerts = [] }) {
  if (alerts.length === 0) {
    return (
      <div className="text-center text-secondary py-4">
        <i className="bi bi-check2-circle fs-3 d-block mb-2" aria-hidden="true" />
        Nothing needs attention for this period.
      </div>
    );
  }

  return (
    <div className="list-group list-group-flush">
      {alerts.map((alert) => {
        const style = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.INFO;

        return (
          <Link
            key={`${alert.type}-${alert.title}`}
            to={alert.link}
            className={`list-group-item list-group-item-action d-flex align-items-start gap-3 border-start border-4 ${style.border}`}
          >
            <i className={`bi ${style.icon} ${style.text} fs-5 mt-1`} aria-hidden="true" />
            <div className="flex-grow-1 min-w-0">
              <div className="fw-semibold">{alert.title}</div>
              {alert.detail ? <div className="small text-secondary">{alert.detail}</div> : null}
            </div>
            <i className="bi bi-chevron-right text-secondary mt-1" aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}
