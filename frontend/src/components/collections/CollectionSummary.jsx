import { formatCurrency } from '../../utils/loanConstants';

/**
 * A loan's payment position. Every figure comes from the API, which derives it
 * from the instalment rows — nothing is totalled in the browser.
 */
export default function CollectionSummary({ summary }) {
  if (!summary) return null;

  const tiles = [
    { key: 'repayment', label: 'Total repayment', value: formatCurrency(summary.totalRepayment), accent: 'primary', icon: 'bi-wallet2' },
    { key: 'collected', label: 'Collected', value: formatCurrency(summary.totalCollected), accent: 'success', icon: 'bi-cash-stack' },
    { key: 'outstanding', label: 'Outstanding', value: formatCurrency(summary.totalOutstanding), accent: 'warning', icon: 'bi-hourglass-split' },
    { key: 'paid', label: 'Paid EMIs', value: `${summary.paidEmiCount} / ${summary.emiCount}`, accent: 'success', icon: 'bi-check2-circle' },
    { key: 'partial', label: 'Partial EMIs', value: summary.partialEmiCount, accent: 'warning', icon: 'bi-pie-chart' },
    { key: 'overdue', label: 'Overdue EMIs', value: summary.overdueEmiCount, accent: 'danger', icon: 'bi-exclamation-triangle' },
    { key: 'remaining', label: 'Remaining EMIs', value: summary.remainingEmiCount, accent: 'info', icon: 'bi-list-ol' },
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
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
