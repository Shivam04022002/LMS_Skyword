import { formatCurrency } from '../../utils/loanConstants';

/**
 * Collection efficiency as a Bootstrap progress bar — no chart dependency.
 *
 * The percentage comes from the API; this only picks a colour band and renders
 * the definition so the denominator is never ambiguous on screen.
 */
export default function EfficiencyBar({ percent, collected, dueValue, definition, compact = false }) {
  if (percent === null || percent === undefined) {
    return <span className="text-secondary small">No instalments due yet</span>;
  }

  const variant = percent >= 80 ? 'success' : percent >= 50 ? 'warning' : 'danger';
  const clamped = Math.min(100, Math.max(0, percent));

  if (compact) {
    return (
      <div className="d-flex align-items-center gap-2">
        <div className="progress flex-grow-1" style={{ height: '0.5rem', minWidth: '4rem' }}>
          <div className={`progress-bar bg-${variant}`} style={{ width: `${clamped}%` }} role="presentation" />
        </div>
        <span className={`small fw-semibold text-${variant}`} style={{ minWidth: '3.2rem' }}>
          {percent}%
        </span>
      </div>
    );
  }

  return (
    <div className="card border-0 shadow-sm h-100">
      <div className="card-body">
        <div className="d-flex align-items-baseline justify-content-between mb-2">
          <span className="text-secondary text-uppercase small fw-semibold">Collection efficiency</span>
          <span className={`fs-4 fw-bold text-${variant}`}>{percent}%</span>
        </div>

        <div className="progress mb-2" style={{ height: '0.75rem' }}>
          <div
            className={`progress-bar bg-${variant}`}
            style={{ width: `${clamped}%` }}
            role="progressbar"
            aria-valuenow={clamped}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Collection efficiency"
          />
        </div>

        <div className="d-flex justify-content-between small">
          <span className="text-success fw-semibold">{formatCurrency(collected)} collected</span>
          <span className="text-secondary">of {formatCurrency(dueValue)} due</span>
        </div>

        {definition ? <p className="form-text mt-2 mb-0">{definition}</p> : null}
      </div>
    </div>
  );
}
