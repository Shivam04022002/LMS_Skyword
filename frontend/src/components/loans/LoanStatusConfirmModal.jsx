import { useEffect, useRef, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import usePermissions from '../../hooks/usePermissions';
import { getLoanCollectionSummary } from '../../services/collectionService';
import { PERMISSIONS } from '../../utils/permissions';
import { formatCurrency } from '../../utils/loanConstants';

/**
 * Confirmation before closing or cancelling a loan.
 *
 * Both actions are TERMINAL in the backend lifecycle — `loanStatusService`
 * allows no transition out of CLOSED or CANCELLED — so neither can be undone
 * from the application. Neither deletes anything: `changeStatus` writes the new
 * status and nothing else, leaving the EMI schedule, collections, allocations
 * and receipts in place as history.
 *
 * What each wording says below is taken from that implementation, not assumed.
 * In particular the backend does NOT require a loan to be repaid before it is
 * closed, so this dialog says so and shows the outstanding balance rather than
 * implying a check that does not exist.
 */

const VARIANTS = {
  CLOSED: {
    title: 'Close Loan',
    lead: 'Are you sure you want to close this loan? Please verify that the loan is eligible for closure.',
    confirmLabel: 'Confirm Close Loan',
    dismissLabel: 'Keep Loan Open',
    confirmClass: 'btn-primary',
    icon: 'bi-check2-circle',
    progress: 'Closing loan…'
  },
  CANCELLED: {
    title: 'Cancel Loan',
    lead: 'Are you sure you want to cancel this loan? Please review the loan details before proceeding.',
    confirmLabel: 'Confirm Cancel Loan',
    dismissLabel: 'Keep Loan',
    confirmClass: 'btn-danger',
    icon: 'bi-x-octagon',
    progress: 'Cancelling loan…'
  }
};

export default function LoanStatusConfirmModal({ open, status, loan, onDismiss, onConfirm }) {
  const { can } = usePermissions();
  const variant = VARIANTS[status];

  const [summary, setSummary] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Focus lands on the SAFE choice, so a stray Enter keeps the loan as it is.
  const dismissRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSubmitting(false);
    dismissRef.current?.focus();
  }, [open, status]);

  /*
   * The loan payload carries no balance, so the outstanding figure comes from
   * the existing per-loan collection summary. It is supporting information, not
   * a gate: if the caller cannot read collections, or the request fails, the
   * dialog still works and simply shows less.
   */
  useEffect(() => {
    if (!open || !loan?.id || !can(PERMISSIONS.COLLECTIONS_VIEW)) {
      setSummary(null);
      return undefined;
    }

    let cancelled = false;
    getLoanCollectionSummary(loan.id)
      .then((response) => {
        if (!cancelled) setSummary(response.data.summary);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, loan?.id, can]);

  if (!open || !variant || !loan) return null;

  const applicantName = loan.applicant?.customer?.fullName ?? null;
  const outstanding = summary?.totalOutstanding ?? null;
  const hasOutstanding = outstanding !== null && Number(outstanding) > 0;
  const collectionCount = summary?.postedCollectionCount ?? null;

  const handleConfirm = async () => {
    // A second click while the request is in flight must not post again.
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onConfirm(status);
    } catch (requestError) {
      // The backend is the authority on whether the loan is still eligible;
      // its message is shown as-is rather than being reworded here.
      setError(requestError.message || 'The loan could not be updated.');
      setSubmitting(false);
    }
  };

  const Detail = ({ label, children }) => (
    <>
      <dt className="col-5 text-secondary fw-normal">{label}</dt>
      <dd className="col-7 mb-1">{children}</dd>
    </>
  );

  return (
    <Modal
      title={variant.title}
      open={open}
      onClose={submitting ? () => {} : onDismiss}
      footer={
        <>
          <button
            type="button"
            ref={dismissRef}
            className="btn btn-outline-secondary"
            onClick={onDismiss}
            disabled={submitting}
          >
            {variant.dismissLabel}
          </button>
          <button type="button" className={`btn ${variant.confirmClass}`} onClick={handleConfirm} disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                {variant.progress}
              </>
            ) : (
              <>
                <i className={`bi ${variant.icon} me-2`} aria-hidden="true" />
                {variant.confirmLabel}
              </>
            )}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <AlertMessage message={error} onDismiss={() => setError('')} />

        <p className="mb-3">{variant.lead}</p>

        <dl className="row small mb-3">
          <Detail label="Loan number">
            <span className="font-monospace">{loan.loanNumber}</span>
          </Detail>
          {applicantName ? <Detail label="Applicant">{applicantName}</Detail> : null}
          <Detail label="Current status">{loan.status}</Detail>
          {outstanding !== null ? <Detail label="Outstanding">{formatCurrency(outstanding)}</Detail> : null}
          {summary ? <Detail label="Collected">{formatCurrency(summary.totalCollected)}</Detail> : null}
          {collectionCount !== null ? (
            <Detail label="Posted collections">{collectionCount}</Detail>
          ) : null}
        </dl>

        {/*
          * Both statuses are terminal in loanStatusService, and no further
          * collection can be posted because collectionService accepts money
          * only against an ACTIVE loan.
          */}
        <div className="alert alert-warning d-flex align-items-start gap-2 mb-2" role="alert">
          <i className="bi bi-exclamation-triangle-fill mt-1" aria-hidden="true" />
          <div>
            <strong>This cannot be undone.</strong> A {status === 'CLOSED' ? 'closed' : 'cancelled'} loan is final — it
            cannot be reopened or returned to active, and no further collections can be posted against it.
          </div>
        </div>

        {status === 'CLOSED' && hasOutstanding ? (
          <div className="alert alert-danger d-flex align-items-start gap-2 mb-2" role="alert">
            <i className="bi bi-cash-stack mt-1" aria-hidden="true" />
            <div>
              This loan still has <strong>{formatCurrency(outstanding)}</strong> outstanding. Closing is <em>not</em>{' '}
              blocked by the system — it does not check that a loan has been repaid — so please confirm this is a
              settlement or write-off before continuing.
            </div>
          </div>
        ) : null}

        {status === 'CANCELLED' && collectionCount > 0 ? (
          <div className="alert alert-danger d-flex align-items-start gap-2 mb-2" role="alert">
            <i className="bi bi-receipt mt-1" aria-hidden="true" />
            <div>
              Money has already been collected against this loan ({collectionCount}{' '}
              {collectionCount === 1 ? 'collection' : 'collections'}, {formatCurrency(summary.totalCollected)}).
              Cancelling is <em>not</em> blocked by the system, and those collections are kept — but the loan will read
              as cancelled alongside them.
            </div>
          </div>
        ) : null}

        <p className="form-text mb-0">
          <i className="bi bi-shield-check me-1" aria-hidden="true" />
          Nothing is deleted: the EMI schedule, collections, allocations and receipts are all retained as financial
          history. Only the loan&apos;s status changes, and the change is recorded in the audit log.
        </p>
      </div>
    </Modal>
  );
}
