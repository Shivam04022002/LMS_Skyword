import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import { getCollectionReceipt } from '../../services/collectionService';
import { formatCurrency } from '../../utils/loanConstants';
import skywordLogo from '../../assets/SkyWord Logo.png';

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

/**
 * Printable collection receipt.
 *
 * A read-only view of an existing collection — no PDF library is involved; the
 * browser's own print pipeline produces the document. Print styles in theme.css
 * drop the app chrome so only the receipt sheet appears on paper, and the same
 * markup serves both screen and paper: there is one receipt, not two that can
 * drift apart.
 *
 * The masthead carries the logo and the organisation name and nothing else. No
 * address, registration number or contact detail appears anywhere, because none
 * of that is real data this system holds.
 *
 * A reversed collection still renders, because the document is part of the
 * audit trail, but it is stamped and captioned so it cannot be mistaken for
 * proof of payment.
 */
export default function CollectionReceiptPage() {
  const { id } = useParams();
  const [receipt, setReceipt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getCollectionReceipt(id);
      setReceipt(response.data.receipt);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load this receipt.');
      setReceipt(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spinner label="Loading receipt…" />;

  if (!receipt) {
    return (
      <div className="container-fluid px-0">
        <Link className="btn btn-sm btn-outline-secondary mb-3" to="/collections">
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          Back to collections
        </Link>
        <AlertMessage message={error} onDismiss={() => setError('')} />
      </div>
    );
  }

  const reversed = receipt.validity.reversed;

  return (
    <div className="container-fluid px-0">
      {/* Screen-only controls — hidden when printing. */}
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3 d-print-none">
        <Link className="btn btn-sm btn-outline-secondary" to={`/collections/${receipt.collection.id}`}>
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          Back to collection
        </Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          <i className="bi bi-printer me-2" aria-hidden="true" />
          Print receipt
        </button>
      </div>

      <AlertMessage message={error} onDismiss={() => setError('')} />

      {reversed ? (
        <div className="alert alert-danger d-flex align-items-start gap-2 d-print-none">
          <i className="bi bi-exclamation-octagon-fill fs-4" aria-hidden="true" />
          <div>
            <strong>This collection was reversed.</strong> {receipt.validity.notice}
          </div>
        </div>
      ) : null}

      <div className="lms-receipt-sheet mx-auto">
        {reversed ? <div className="lms-receipt-stamp">REVERSED</div> : null}

        <header className="lms-receipt-header">
          <div className="lms-receipt-masthead">
            {/* Intrinsic dimensions are declared so the browser reserves the
                right box before the file loads and never rescales it unevenly. */}
            <img
              className="lms-receipt-logo"
              src={skywordLogo}
              width="1672"
              height="941"
              alt="Skyword Micro Finance"
            />
            <div className="lms-receipt-identity">
              <h1 className="lms-receipt-company">{receipt.organisationName}</h1>
              <p className="lms-receipt-doctype">{receipt.title}</p>
            </div>
          </div>

          <div className="lms-receipt-meta">
            <div className="lms-receipt-meta-label">Receipt no.</div>
            <div className="lms-receipt-number">{receipt.collection.collectionNumber}</div>
            <div className="lms-receipt-meta-note">Issued {formatDate(receipt.generatedAt)}</div>
          </div>
        </header>

        <section className="row g-4 lms-receipt-parties">
          <div className="col-12 col-sm-6">
            <h2 className="lms-receipt-section">Customer</h2>
            <dl className="lms-receipt-list mb-0">
              <dt>Name</dt>
              <dd className="fw-semibold">{receipt.customer?.fullName ?? '—'}</dd>
              <dt>CIF</dt>
              <dd className="font-monospace">{receipt.customer?.cifId ?? '—'}</dd>
              <dt>Mobile</dt>
              <dd className="font-monospace">{receipt.customer?.mobile ?? '—'}</dd>
              <dt>Loan number</dt>
              <dd className="font-monospace">{receipt.loan?.loanNumber ?? '—'}</dd>
            </dl>
          </div>

          <div className="col-12 col-sm-6">
            <h2 className="lms-receipt-section">Payment</h2>
            <dl className="lms-receipt-list mb-0">
              <dt>Collection date</dt>
              <dd className="fw-semibold">{formatDate(receipt.collection.collectionDate)}</dd>
              <dt>Amount</dt>
              <dd className="fw-bold">{formatCurrency(receipt.collection.amount)}</dd>
              <dt>Ledger</dt>
              <dd>{receipt.collection.ledgerType}</dd>
              <dt>Reference</dt>
              <dd className="text-break">{receipt.collection.paymentReference || '—'}</dd>
              <dt>Route</dt>
              <dd>{receipt.route ? `${receipt.route.routeCode} — ${receipt.route.name}` : '—'}</dd>
            </dl>
          </div>
        </section>

        <section className="lms-receipt-block">
          <h2 className="lms-receipt-section">Allocation</h2>
          <div className="table-responsive">
            <table className="table table-sm lms-receipt-table mb-0">
              <thead>
                <tr>
                  <th scope="col">EMI #</th>
                  <th scope="col">Due date</th>
                  <th scope="col" className="text-end">EMI amount</th>
                  <th scope="col" className="text-end">Amount allocated</th>
                </tr>
              </thead>
              <tbody>
                {receipt.allocations.map((allocation) => (
                  <tr key={allocation.id}>
                    <td className="fw-semibold">{allocation.emiNumber ?? '—'}</td>
                    <td>{formatDate(allocation.emiDate)}</td>
                    <td className="text-end">{formatCurrency(allocation.emiAmount)}</td>
                    <td className="text-end fw-semibold">{formatCurrency(allocation.allocatedAmount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan="3" className="text-end">Total allocated to instalments</th>
                  <th className="text-end">{formatCurrency(receipt.totals.allocatedAmount)}</th>
                </tr>
                {/* Money received against a bounce charge, so it appears here
                    rather than in the allocation rows above — it was never
                    applied to an instalment. The two lines add up to the total. */}
                <tr>
                  <th colSpan="3" className="text-end">Bounce collection</th>
                  <th className="text-end">{formatCurrency(receipt.totals.bounceAmount)}</th>
                </tr>
                <tr className="lms-receipt-total">
                  <th colSpan="3" className="text-end">Total collection amount</th>
                  <th className="text-end">{formatCurrency(receipt.totals.collectionAmount)}</th>
                </tr>
              </tfoot>
            </table>
          </div>

          {!receipt.totals.reconciles ? (
            <p className="text-danger small mt-2 mb-0">
              Allocation plus bounce collection does not reconcile with the collection amount — unaccounted for{' '}
              {formatCurrency(receipt.totals.unallocated)}.
            </p>
          ) : null}
        </section>

        {reversed ? (
          <section className="lms-receipt-block">
            <div className="lms-receipt-void">
              <strong>NOT A VALID RECEIPT OF PAYMENT.</strong> {receipt.validity.notice}
            </div>
          </section>
        ) : null}

        {receipt.collection.notes ? (
          <section className="lms-receipt-block">
            <h2 className="lms-receipt-section">Notes</h2>
            <p className="small mb-0">{receipt.collection.notes}</p>
          </section>
        ) : null}

        <footer className="lms-receipt-footer">
          <div className="row g-3 small text-secondary">
            <div className="col-12 col-sm-6">
              <div>
                Received by: <span className="fw-semibold text-body">{receipt.system.createdBy ?? '—'}</span>
              </div>
              <div>Recorded: {formatDateTime(receipt.system.createdAt)}</div>
            </div>
            <div className="col-12 col-sm-6 text-sm-end">
              <div className="lms-receipt-signature">Authorised signature</div>
            </div>
          </div>
          <p className="lms-receipt-fineprint">
            This is a computer-generated receipt for collection {receipt.collection.collectionNumber}.
          </p>
        </footer>
      </div>
    </div>
  );
}
