import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import Modal from '../../components/common/Modal';
import CollectionStatusBadge from '../../components/collections/CollectionStatusBadge';
import CollectionAllocationTable from '../../components/collections/CollectionAllocationTable';
import CollectionSummary from '../../components/collections/CollectionSummary';
import usePermissions from '../../hooks/usePermissions';
import { getCollection, reverseCollection, getLoanCollectionSummary } from '../../services/collectionService';
import { PERMISSIONS } from '../../utils/permissions';
import { formatCurrency } from '../../utils/loanConstants';
import { LEDGER_ICONS } from '../../utils/collectionConstants';

function Row({ label, children }) {
  return (
    <>
      <dt className="col-6 col-sm-5 text-secondary fw-normal">{label}</dt>
      <dd className="col-6 col-sm-7">{children ?? <span className="text-secondary">—</span>}</dd>
    </>
  );
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
}

export default function CollectionDetailsPage() {
  const { id } = useParams();
  const { can } = usePermissions();

  const [collection, setCollection] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getCollection(id);
      const data = response.data.collection;
      setCollection(data);

      // Refetched rather than derived locally, so the loan position always
      // reflects the backend after a reversal.
      if (data.loan?.id) {
        const summaryResponse = await getLoanCollectionSummary(data.loan.id);
        setSummary(summaryResponse.data.summary);
      }
    } catch (requestError) {
      setError(requestError.message || 'Unable to load this collection.');
      setCollection(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleReverse = async () => {
    setBusy(true);
    setError('');
    try {
      await reverseCollection(id, reason.trim() || undefined);
      setReverseOpen(false);
      setReason('');
      setNotice('Collection reversed. The affected instalments have been recalculated.');
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading collection…" />;

  const isPosted = collection?.status === 'POSTED';
  const canReverse = isPosted && can(PERMISSIONS.COLLECTIONS_REVERSE);

  return (
    <div className="container-fluid px-0">
      <Link className="btn btn-sm btn-outline-secondary mb-3" to="/collections">
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        Back to collections
      </Link>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      {collection ? (
        <>
          {collection.status === 'REVERSED' ? (
            <div className="alert alert-danger d-flex align-items-center gap-2">
              <i className="bi bi-exclamation-octagon-fill fs-4" aria-hidden="true" />
              <div>
                <strong>This collection has been reversed.</strong> Its payment effect has been removed from the affected
                instalments. The record is retained for history.
              </div>
            </div>
          ) : null}

          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body d-flex flex-wrap align-items-center justify-content-between gap-3">
              <div>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <span className="badge text-bg-light border font-monospace fs-6">{collection.collectionNumber}</span>
                  <CollectionStatusBadge status={collection.status} size="lg" />
                </div>
                <h1 className="h3 fw-bold mb-0">{formatCurrency(collection.amount)}</h1>
              </div>

              <div className="d-flex flex-wrap gap-2">
                {can(PERMISSIONS.RECEIPTS_VIEW) ? (
                  <Link className="btn btn-outline-primary" to={`/collections/${id}/receipt`}>
                    <i className="bi bi-printer me-2" aria-hidden="true" />
                    View receipt
                  </Link>
                ) : null}
                {canReverse ? (
                  <button type="button" className="btn btn-outline-danger" onClick={() => setReverseOpen(true)} disabled={busy}>
                    <i className="bi bi-arrow-counterclockwise me-2" aria-hidden="true" />
                    Reverse collection
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="row g-4 mb-4">
            <div className="col-12 col-lg-6">
              <div className="card border-0 shadow-sm h-100">
                <div className="card-body">
                  <h2 className="h6 fw-bold mb-3">
                    <i className="bi bi-receipt me-2 text-primary" aria-hidden="true" />
                    Collection
                  </h2>
                  <dl className="row mb-0">
                    <Row label="Loan">
                      {collection.loan ? (
                        <Link className="font-monospace" to={`/loans/${collection.loan.id}`}>
                          {collection.loan.loanNumber}
                        </Link>
                      ) : null}
                    </Row>
                    <Row label="Customer">
                      {collection.customer ? (
                        <>
                          <div>{collection.customer.fullName}</div>
                          <div className="small text-secondary font-monospace">{collection.customer.cifId}</div>
                        </>
                      ) : null}
                    </Row>
                    <Row label="Collection date">{formatDate(collection.collectionDate)}</Row>
                    {/*
                      * The split of the headline amount above. Bounce collection
                      * is money actually received against a bounce charge; it is
                      * inside the total, never added to it, and is deliberately
                      * absent from the allocation table below because it was
                      * never applied to an instalment.
                      */}
                    <Row label="EMI collected">{formatCurrency(collection.emiCollected)}</Row>
                    <Row label="Bounce collection">{formatCurrency(collection.bounceCollected)}</Row>
                    <Row label="Ledger">
                      <i className={`bi ${LEDGER_ICONS[collection.ledgerType]} me-1`} aria-hidden="true" />
                      {collection.ledgerType}
                    </Row>
                    <Row label="Payment reference">{collection.paymentReference}</Row>
                    <Row label="Notes">{collection.notes}</Row>
                  </dl>
                </div>
              </div>
            </div>

            <div className="col-12 col-lg-6">
              <div className="card border-0 shadow-sm h-100">
                <div className="card-body">
                  <h2 className="h6 fw-bold mb-3">
                    <i className="bi bi-info-circle me-2 text-primary" aria-hidden="true" />
                    System information
                  </h2>
                  <dl className="row mb-0">
                    <Row label="Created by">{collection.createdBy?.name}</Row>
                    <Row label="Created">{collection.createdAt ? new Date(collection.createdAt).toLocaleString() : null}</Row>
                    <Row label="Last updated by">{collection.updatedBy?.name}</Row>
                    <Row label="Updated">{collection.updatedAt ? new Date(collection.updatedAt).toLocaleString() : null}</Row>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body">
              <h2 className="h6 fw-bold mb-3">Allocation breakdown</h2>
              <CollectionAllocationTable allocations={collection.allocations} reversed={collection.status === 'REVERSED'} />
            </div>
          </div>

          {summary ? (
            <div className="mb-4">
              <h2 className="h5 fw-bold mb-3">Loan position</h2>
              <CollectionSummary summary={summary} />
            </div>
          ) : null}

          <Modal
            title="Reverse collection"
            open={reverseOpen}
            onClose={busy ? () => {} : () => setReverseOpen(false)}
            footer={
              <>
                <button type="button" className="btn btn-outline-secondary" onClick={() => setReverseOpen(false)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="btn btn-danger" onClick={handleReverse} disabled={busy}>
                  {busy ? 'Reversing…' : 'Reverse collection'}
                </button>
              </>
            }
          >
            <div className="modal-body">
              <p>
                Reverse this collection? This will remove its payment effect from the affected EMIs. The record is kept
                for history and cannot be un-reversed.
              </p>
              <label className="form-label small fw-semibold" htmlFor="reverse-reason">
                Reason (optional)
              </label>
              <input
                id="reverse-reason"
                className="form-control"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. cheque bounced"
                disabled={busy}
              />
            </div>
          </Modal>
        </>
      ) : null}
    </div>
  );
}
