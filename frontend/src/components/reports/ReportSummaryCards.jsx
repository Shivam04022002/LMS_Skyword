/**
 * Report summary tiles.
 *
 * Every value is passed in from the backend's `summary` object — this component
 * performs no arithmetic of its own, so a displayed total can never disagree
 * with the ledger.
 */
export default function ReportSummaryCards({ tiles = [] }) {
  if (tiles.length === 0) return null;

  return (
    <div className="row g-3">
      {tiles.map((tile) => (
        <div className="col-6 col-md-4 col-xl-3" key={tile.key}>
          <div className="card border-0 shadow-sm h-100">
            <div className="card-body d-flex align-items-start gap-3 py-3">
              <span className={`lms-stat-icon bg-${tile.accent ?? 'primary'}-subtle text-${tile.accent ?? 'primary'}`}>
                <i className={`bi ${tile.icon ?? 'bi-dot'}`} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="text-secondary text-uppercase small fw-semibold">{tile.label}</div>
                <div className="fw-bold">{tile.value}</div>
                {tile.sub ? <div className="text-secondary small">{tile.sub}</div> : null}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
