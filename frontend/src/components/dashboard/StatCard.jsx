/**
 * Metric tile for the dashboard.
 * Phase 1 has no data sources yet, so cards render a placeholder note instead
 * of an invented figure.
 */
export default function StatCard({ title, icon, note = 'Coming in future phase', accent = 'primary' }) {
  return (
    <div className="card lms-stat-card h-100 border-0 shadow-sm">
      <div className="card-body d-flex align-items-start gap-3">
        <span className={`lms-stat-icon bg-${accent}-subtle text-${accent}`}>
          <i className={`bi ${icon}`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="h6 text-secondary text-uppercase fw-semibold mb-1">{title}</h2>
          <p className="lms-stat-value mb-1">—</p>
          <span className="badge text-bg-light fw-normal">{note}</span>
        </div>
      </div>
    </div>
  );
}
