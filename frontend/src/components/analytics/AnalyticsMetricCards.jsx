/*
 * The summary metric cards.
 *
 * Presentation only: every value, label and description arrives already computed
 * from the backend's own summary block, exactly as before. This component does
 * no arithmetic and no formatting of its own, so a card can never disagree with
 * the ledger.
 *
 * Cards share one height through `h-100` on a Bootstrap row, so two cards and
 * four cards both line up; the number is the largest thing in the card, and a
 * long INR figure wraps inside it rather than widening it.
 */

export default function AnalyticsMetricCards({ tiles = [], loading }) {
  if (tiles.length === 0 && !loading) return null;

  if (loading && tiles.length === 0) {
    // Placeholders at the real card height, so applying a filter does not make
    // the charts below jump up and then back down.
    return (
      <div className="row g-3">
        {[0, 1, 2].map((index) => (
          <div className="col-6 col-lg-3" key={index}>
            <div className="lms-analytics-surface lms-analytics-metric">
              <span className="lms-analytics-metric-icon bg-body-secondary" aria-hidden="true" />
              <div className="min-w-0 w-100">
                <div className="placeholder-glow">
                  <span className="placeholder col-7" />
                  <span className="placeholder col-10 mt-2" style={{ height: '1.25rem' }} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="row g-3">
      {tiles.map((tile) => (
        // Two per row on a phone, four on a laptop; never a single orphan on its
        // own row for the two-card sections.
        <div className={tiles.length <= 2 ? 'col-12 col-sm-6' : 'col-6 col-lg-3'} key={tile.key}>
          <div className="lms-analytics-surface lms-analytics-metric">
            <span
              className={`lms-analytics-metric-icon bg-${tile.accent ?? 'primary'}-subtle text-${tile.accent ?? 'primary'}`}
              aria-hidden="true"
            >
              <i className={`bi ${tile.icon ?? 'bi-dot'}`} />
            </span>
            <div className="min-w-0">
              <p className="lms-analytics-metric-label">{tile.label}</p>
              <p className="lms-analytics-metric-value">{tile.value}</p>
              {tile.sub ? <p className="lms-analytics-metric-sub">{tile.sub}</p> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
