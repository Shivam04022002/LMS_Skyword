import { formatCurrency } from '../../utils/loanConstants';

/**
 * Loan-level schedule totals. Every figure comes from the API's summary object,
 * which derives them from the stored instalments — nothing is computed or
 * guessed in the browser.
 */
export default function EmiSummary({ summary }) {
  if (!summary) return null;

  const tiles = [
    { key: 'emiCount', label: 'Total EMIs', value: summary.emiCount, accent: 'primary', icon: 'bi-list-ol' },
    { key: 'principal', label: 'Total principal', value: formatCurrency(summary.totalPrincipal), accent: 'primary', icon: 'bi-cash' },
    { key: 'interest', label: 'Total interest', value: formatCurrency(summary.totalInterest), accent: 'info', icon: 'bi-percent' },
    { key: 'repayment', label: 'Total repayment', value: formatCurrency(summary.totalRepayment), accent: 'success', icon: 'bi-wallet2' },
    { key: 'collected', label: 'Paid amount', value: formatCurrency(summary.totalCollected), accent: 'success', icon: 'bi-check2-circle' },
    { key: 'outstanding', label: 'Outstanding', value: formatCurrency(summary.totalOutstanding), accent: 'warning', icon: 'bi-hourglass-split' },
    { key: 'overdue', label: 'Overdue EMIs', value: summary.overdueCount, accent: 'danger', icon: 'bi-exclamation-triangle' },
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
