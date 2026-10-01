/*
 * The summary metric cards.
 *
 * Presentation only: every value, label and description arrives already computed
 * from the backend's own summary block, exactly as before. This component does
 * no arithmetic and no formatting of its own, so a card can never disagree with
 * the ledger.
 *
 * The grid is chosen from how many cards there actually are, so a two-card
 * section fills the row with two halves rather than leaving two quarter-width
 * gaps, and a four-card section goes four across and then folds to two and one.
 */

/** Four across when there are four, and an even split when there are fewer. */
const COLUMN_CLASS = {
  1: 'col-12',
  2: 'col-12 col-sm-6',
  3: 'col-12 col-sm-6 col-xl-4',
  4: 'col-6 col-xl-3'
};

export default function AnalyticsMetricCards({ tiles = [], loading }) {
  if (tiles.length === 0 && !loading) return null;

  if (loading && tiles.length === 0) {
    // Placeholders at the real card height, so applying a filter does not make
    // the charts below jump up and then back down.
    return (
      <div className="row g-3">
        {[0, 1, 2, 3].map((index) => (
          <div className="col-6 col-xl-3" key={index}>
            <div className="lms-analytics-surface lms-analytics-metric">
              <span className="lms-analytics-metric-icon bg-body-secondary" aria-hidden="true" />
              <div className="min-w-0 w-100 placeholder-glow">
                <span className="placeholder col-7" />
                <span className="placeholder col-10 mt-2 d-block" style={{ height: '1.25rem' }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const columns = COLUMN_CLASS[tiles.length] ?? 'col-6 col-xl-3';

  return (
    <div className="row g-3">
      {tiles.map((tile) => (
        <div className={columns} key={tile.key}>
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
