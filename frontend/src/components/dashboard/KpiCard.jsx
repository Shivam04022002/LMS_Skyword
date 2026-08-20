import { Link } from 'react-router-dom';

/**
 * A single KPI.
 *
 * Values arrive already formatted from the caller, which takes them from the
 * dashboard API — no arithmetic happens in this component. `to` is only set
 * where a genuinely relevant destination exists, so cards are not clickable for
 * the sake of it.
 */
export default function KpiCard({ label, value, period, sub, icon, accent = 'primary', to }) {
  const body = (
    <div className="card-body d-flex align-items-start gap-3">
      <span className={`lms-stat-icon bg-${accent}-subtle text-${accent}`}>
        <i className={`bi ${icon ?? 'bi-dot'}`} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-secondary text-uppercase small fw-semibold">{label}</div>
        <div className="lms-kpi-value">{value}</div>
        {sub ? <div className="small text-secondary">{sub}</div> : null}
        {period ? <div className="small text-secondary">{period}</div> : null}
      </div>
    </div>
  );

  if (!to) {
    return <div className="card border-0 shadow-sm h-100">{body}</div>;
  }

  return (
    <Link className="card border-0 shadow-sm h-100 text-decoration-none text-reset lms-kpi-link" to={to}>
      {body}
    </Link>
  );
}
