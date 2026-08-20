import { formatCurrency } from '../../utils/loanConstants';

/**
 * Demand totals.
 *
 * Every figure is taken straight from the API's `summary` object. Nothing is
 * totalled in the browser — the backend derives demand from the allocation
 * ledger and is the only authority on these numbers.
 */
export default function DemandSummary({ summary }) {
  if (!summary) return null;

  const tiles = [
    { key: 'total', label: 'Total demand', value: formatCurrency(summary.totalDemand), accent: 'primary', icon: 'bi-cash-stack' },
    { key: 'overdue', label: 'Overdue', value: formatCurrency(summary.overdueAmount), sub: `${summary.overdueCount} EMI`, accent: 'danger', icon: 'bi-exclamation-triangle' },
    { key: 'dueToday', label: 'Due today', value: formatCurrency(summary.dueTodayAmount), sub: `${summary.dueTodayCount} EMI`, accent: 'primary', icon: 'bi-calendar-event' },
    { key: 'upcoming', label: 'Upcoming', value: formatCurrency(summary.upcomingAmount), sub: `${summary.upcomingCount} EMI`, accent: 'secondary', icon: 'bi-hourglass' },
    { key: 'partial', label: 'Partially paid', value: summary.partialCount, accent: 'warning', icon: 'bi-pie-chart' },
    { key: 'emis', label: 'EMIs', value: summary.emiCount, accent: 'info', icon: 'bi-list-ol' },
    { key: 'loans', label: 'Loans', value: summary.loanCount, accent: 'info', icon: 'bi-cash-coin' },
    { key: 'maxDpd', label: 'Max DPD', value: `${summary.maxDpd} day${summary.maxDpd === 1 ? '' : 's'}`, accent: 'danger', icon: 'bi-calendar-x' }
  ];

  return (
    <div className="row g-3">
      {tiles.map((tile) => (
        <div className="col-6 col-md-4 col-xl-3" key={tile.key}>
          <div className="card border-0 shadow-sm h-100">
            <div className="card-body d-flex align-items-start gap-3 py-3">
              <span className={`lms-stat-icon bg-${tile.accent}-subtle text-${tile.accent}`}>
                <i className={`bi ${tile.icon}`} aria-hidden="true" />
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
