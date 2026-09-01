import { useCallback, useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import Spinner from '../common/Spinner';
import EmiStatusBadge from '../emis/EmiStatusBadge';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { createCollection } from '../../services/collectionService';
import { getLoans, getLoan } from '../../services/loanService';
import { getEmiSchedule } from '../../services/emiService';
import { toFieldErrors } from '../../utils/errorHandler';
import { toMinorUnits, fromMinorUnits } from '../../utils/decimal';
import { formatCurrency } from '../../utils/loanConstants';
import { LEDGER_TYPES, requiresPaymentReference } from '../../utils/collectionConstants';
import { today } from '../../utils/today';

const EMPTY = {
  amount: '',
  collectionDate: today(),
  ledgerType: 'CASH',
  paymentReference: '',
  notes: ''
};

/**
 * Posts a collection against a loan.
 *
 * The form enforces the same rules as the backend so mistakes surface before
 * submission — full allocation, nothing over an instalment's outstanding — but
 * these checks are convenience only. The backend re-validates everything under
 * row locks and is the sole authority.
 */
export default function CollectionFormModal({ open, loan: presetLoan = null, onClose, onSaved }) {
  const [loanSearch, setLoanSearch] = useState('');
  const [loanResults, setLoanResults] = useState([]);
  const [selectedLoan, setSelectedLoan] = useState(null);
  const [parties, setParties] = useState([]);
  const [customerId, setCustomerId] = useState('');

  const [form, setForm] = useState(EMPTY);
  const [emis, setEmis] = useState([]);
  const [allocations, setAllocations] = useState({});
  /*
   * BOUNCE COLLECTION — how much of this payment the customer handed over
   * against a bounce charge rather than an instalment, entered per instalment
   * so the operator can say which charge is being settled.
   *
   * Their total is posted as the collection's single `bounceAmount`, which is
   * where the backend stores it. It is taken OUT of the amount, never added to
   * it: the allocations must cover amount − bounce, so the bounce rupees never
   * reach an instalment and can never be reported as principal or interest.
   *
   * Left empty — the default — this posts bounceAmount 0.00 and the form
   * behaves exactly as it did before bounce existed.
   */
  const [bounces, setBounces] = useState({});

  const [loadingLoan, setLoadingLoan] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const debouncedLoanSearch = useDebouncedValue(loanSearch, 400);

  const loadLoanContext = useCallback(async (loanId) => {
    setLoadingLoan(true);
    setFormError('');
    try {
      const [loanResponse, scheduleResponse] = await Promise.all([getLoan(loanId), getEmiSchedule(loanId, { limit: 500 })]);
      const loanData = loanResponse.data.loan;

      setSelectedLoan(loanData);

      // Any active party may pay, not only the applicant.
      const loanParties = [loanData.applicant, ...(loanData.coApplicants ?? []), ...(loanData.guarantors ?? [])].filter(Boolean);
      setParties(loanParties);
      setCustomerId(loanData.applicant?.customer?.id ? String(loanData.applicant.customer.id) : '');

      setEmis(scheduleResponse.data.emis.filter((emi) => toMinorUnits(emi.outstanding) > 0));
      setAllocations({});
      setBounces({});
    } catch (error) {
      setFormError(error.message);
      setSelectedLoan(null);
      setEmis([]);
    } finally {
      setLoadingLoan(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setAllocations({});
    setBounces({});
    setFieldErrors({});
    setFormError('');
    setLoanSearch('');
    setLoanResults([]);

    if (presetLoan) {
      loadLoanContext(presetLoan.id);
    } else {
      setSelectedLoan(null);
      setEmis([]);
      setParties([]);
      setCustomerId('');
    }
  }, [open, presetLoan, loadLoanContext]);

  useEffect(() => {
    if (!open || presetLoan || debouncedLoanSearch.trim().length < 2) {
      setLoanResults([]);
      return undefined;
    }

    let cancelled = false;
    getLoans({ search: debouncedLoanSearch.trim(), status: 'ACTIVE', limit: 10 })
      .then((response) => {
        if (!cancelled) setLoanResults(response.data.loans);
      })
      .catch(() => {
        if (!cancelled) setLoanResults([]);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedLoanSearch, open, presetLoan]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => ({ ...current, [name]: undefined }));
  };

  const setAllocation = (emiId, value) => {
    setAllocations((current) => ({ ...current, [emiId]: value }));
  };

  const setBounce = (emiId, value) => {
    setBounces((current) => ({ ...current, [emiId]: value }));
  };

  /*
   * Empty is the default and is valid. Anything else must be a plain
   * non-negative amount with at most two decimals — the same rule
   * `toMinorUnits` applies to every other money field, which returns null for a
   * negative, a stray sign, an exponent or a third decimal place.
   */
  const isBounceValid = (value) => value === undefined || value === '' || toMinorUnits(value) !== null;

  const amountMinor = toMinorUnits(form.amount) ?? 0;
  const allocatedMinor = Object.values(allocations).reduce((total, value) => total + (toMinorUnits(value) ?? 0), 0);
  const bounceMinor = Object.values(bounces).reduce((total, value) => total + (toMinorUnits(value) ?? 0), 0);
  // What the allocations have to cover: the payment less its bounce component.
  const emiTargetMinor = amountMinor - bounceMinor;
  const unallocatedMinor = emiTargetMinor - allocatedMinor;
  const bounceOverAmount = bounceMinor > amountMinor;

  const overAllocated = emis.filter((emi) => {
    const requested = toMinorUnits(allocations[emi.id]);
    return requested !== null && requested > toMinorUnits(emi.outstanding);
  });

  const canSubmit =
    Boolean(selectedLoan) &&
    Boolean(customerId) &&
    amountMinor > 0 &&
    !bounceOverAmount &&
    emis.every((emi) => isBounceValid(bounces[emi.id])) &&
    unallocatedMinor === 0 &&
    overAllocated.length === 0 &&
    !submitting;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    const errors = {};
    if (!selectedLoan) errors.loanId = 'Select a loan';
    if (!customerId) errors.customerId = 'Select who paid';
    if (amountMinor <= 0) errors.amount = 'Enter a positive amount with at most 2 decimals';
    if (requiresPaymentReference(form.ledgerType) && !form.paymentReference.trim()) {
      errors.paymentReference = 'A payment reference is required for bank collections';
    }
    if (bounceOverAmount) errors.amount = 'Bounce is part of the amount received, so it cannot exceed it';
    if (unallocatedMinor !== 0) errors.allocations = 'Allocate the collection amount less its bounce component';

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        loanId: selectedLoan.id,
        customerId: Number(customerId),
        amount: form.amount,
        // The bounce component of that amount, as a single figure. The
        // allocations below are unchanged and still carry only instalment
        // money, so the same rupee is never sent twice.
        bounceAmount: fromMinorUnits(bounceMinor),
        collectionDate: form.collectionDate,
        ledgerType: form.ledgerType,
        paymentReference: form.paymentReference.trim() || null,
        notes: form.notes.trim() || null,
        allocations: Object.entries(allocations)
          .filter(([, value]) => (toMinorUnits(value) ?? 0) > 0)
          .map(([emiId, value]) => ({ emiId: Number(emiId), amount: value }))
      };

      const response = await createCollection(payload);
      onSaved(response.data.collection);
    } catch (error) {
      setFormError(error.message);
      setFieldErrors(toFieldErrors(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Post collection" open={open} onClose={submitting ? () => {} : onClose} size="modal-xl">
      <form onSubmit={handleSubmit} noValidate>
        <div className="modal-body">
          <AlertMessage message={formError} onDismiss={() => setFormError('')} />

          {!presetLoan ? (
            <div className="mb-3">
              <label className="form-label small fw-semibold" htmlFor="collection-loan">
                Loan <span className="text-danger">*</span>
              </label>
              {selectedLoan ? (
                <div className="d-flex align-items-center gap-2">
                  <span className="badge text-bg-light border font-monospace">{selectedLoan.loanNumber}</span>
                  <span className="text-secondary small">{selectedLoan.applicant?.customer?.fullName}</span>
                  <button type="button" className="btn btn-sm btn-link" onClick={() => setSelectedLoan(null)} disabled={submitting}>
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    id="collection-loan"
                    className={`form-control${fieldErrors.loanId ? ' is-invalid' : ''}`}
                    placeholder="Search loan number, CIFID, name or mobile"
                    value={loanSearch}
                    onChange={(event) => setLoanSearch(event.target.value)}
                  />
                  <div className="invalid-feedback">{fieldErrors.loanId}</div>
                  {loanResults.length > 0 ? (
                    <ul className="list-group mt-2">
                      {loanResults.map((loan) => (
                        <li key={loan.id} className="list-group-item d-flex justify-content-between align-items-center gap-2">
                          <span>
                            <span className="font-monospace">{loan.loanNumber}</span>
                            <span className="text-secondary ms-2">{loan.applicant?.fullName}</span>
                          </span>
                          <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => loadLoanContext(loan.id)}>
                            Select
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {loadingLoan ? <Spinner label="Loading loan…" /> : null}

          {selectedLoan && !loadingLoan ? (
            <>
              <div className="row g-3 mb-3">
                <div className="col-12 col-md-4">
                  <label className="form-label small fw-semibold" htmlFor="collection-customer">
                    Paid by <span className="text-danger">*</span>
                  </label>
                  <select
                    id="collection-customer"
                    className={`form-select${fieldErrors.customerId ? ' is-invalid' : ''}`}
                    value={customerId}
                    onChange={(event) => setCustomerId(event.target.value)}
                    disabled={submitting}
                  >
                    <option value="">Select payer…</option>
                    {parties.map((party) => (
                      <option value={party.customer?.id} key={party.id}>
                        {party.customer?.fullName} ({party.partyRole})
                      </option>
                    ))}
                  </select>
                  <div className="invalid-feedback">{fieldErrors.customerId}</div>
                </div>

                <div className="col-6 col-md-2">
                  <label className="form-label small fw-semibold" htmlFor="collection-amount">
                    Amount <span className="text-danger">*</span>
                  </label>
                  <input
                    id="collection-amount"
                    name="amount"
                    className={`form-control${fieldErrors.amount ? ' is-invalid' : ''}`}
                    value={form.amount}
                    onChange={handleChange}
                    inputMode="decimal"
                    disabled={submitting}
                  />
                  <div className="invalid-feedback">{fieldErrors.amount}</div>
                </div>

                <div className="col-6 col-md-2">
                  <label className="form-label small fw-semibold" htmlFor="collection-date">
                    Date <span className="text-danger">*</span>
                  </label>
                  <input
                    id="collection-date"
                    name="collectionDate"
                    type="date"
                    max={today()}
                    className={`form-control${fieldErrors.collectionDate ? ' is-invalid' : ''}`}
                    value={form.collectionDate}
                    onChange={handleChange}
                    disabled={submitting}
                  />
                  <div className="invalid-feedback">{fieldErrors.collectionDate}</div>
                </div>

                <div className="col-6 col-md-2">
                  <label className="form-label small fw-semibold" htmlFor="collection-ledger">
                    Ledger <span className="text-danger">*</span>
                  </label>
                  <select
                    id="collection-ledger"
                    name="ledgerType"
                    className="form-select"
                    value={form.ledgerType}
                    onChange={handleChange}
                    disabled={submitting}
                  >
                    {LEDGER_TYPES.map((type) => (
                      <option value={type} key={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-6 col-md-2">
                  <label className="form-label small fw-semibold" htmlFor="collection-reference">
                    Reference {requiresPaymentReference(form.ledgerType) ? <span className="text-danger">*</span> : null}
                  </label>
                  <input
                    id="collection-reference"
                    name="paymentReference"
                    className={`form-control${fieldErrors.paymentReference ? ' is-invalid' : ''}`}
                    value={form.paymentReference}
                    onChange={handleChange}
                    placeholder={requiresPaymentReference(form.ledgerType) ? 'UTR / cheque no.' : 'Optional'}
                    disabled={submitting}
                  />
                  <div className="invalid-feedback">{fieldErrors.paymentReference}</div>
                </div>

                <div className="col-12">
                  <label className="form-label small fw-semibold" htmlFor="collection-notes">
                    Notes
                  </label>
                  <input
                    id="collection-notes"
                    name="notes"
                    className="form-control"
                    value={form.notes}
                    onChange={handleChange}
                    disabled={submitting}
                  />
                </div>
              </div>

              <h3 className="h6 fw-bold text-uppercase text-secondary small mb-2">Allocate to instalments</h3>

              {emis.length === 0 ? (
                <p className="text-secondary">This loan has no outstanding instalments.</p>
              ) : (
                <div className="table-responsive mb-3">
                  <table className="table table-sm align-middle mb-0">
                    <thead className="table-light">
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Due date</th>
                        <th scope="col" className="text-end">EMI</th>
                        <th scope="col" className="text-end">Collected</th>
                        <th scope="col" className="text-end">Outstanding</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="text-end">Bounce charge</th>
                        <th scope="col" style={{ width: '9rem' }}>Bounce collected</th>
                        <th scope="col" style={{ width: '10rem' }}>Allocate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {emis.map((emi) => {
                        const requested = toMinorUnits(allocations[emi.id]);
                        const exceeds = requested !== null && requested > toMinorUnits(emi.outstanding);
                        const bounceValid = isBounceValid(bounces[emi.id]);

                        return (
                          <tr key={emi.id}>
                            <td className="fw-semibold">{emi.emiNumber}</td>
                            <td>{new Date(emi.emiDate).toLocaleDateString()}</td>
                            <td className="text-end">{formatCurrency(emi.emiAmount)}</td>
                            <td className="text-end">{formatCurrency(emi.amountCollected)}</td>
                            <td className="text-end fw-semibold">{formatCurrency(emi.outstanding)}</td>
                            <td>
                              <EmiStatusBadge status={emi.status} />
                            </td>
                            <td className="text-end small text-secondary">{formatCurrency(emi.bounceCharge)}</td>
                            <td>
                              <input
                                className={`form-control form-control-sm${bounceValid ? '' : ' is-invalid'}`}
                                inputMode="decimal"
                                min="0"
                                placeholder="0.00"
                                value={bounces[emi.id] ?? ''}
                                onChange={(event) => setBounce(emi.id, event.target.value)}
                                disabled={submitting}
                                aria-label={`Bounce collected for instalment ${emi.emiNumber}`}
                              />
                              {bounceValid ? null : <div className="invalid-feedback">Enter 0 or more, max 2 decimals</div>}
                            </td>
                            <td>
                              <input
                                className={`form-control form-control-sm${exceeds ? ' is-invalid' : ''}`}
                                inputMode="decimal"
                                value={allocations[emi.id] ?? ''}
                                onChange={(event) => setAllocation(emi.id, event.target.value)}
                                disabled={submitting}
                                aria-label={`Allocate to instalment ${emi.emiNumber}`}
                              />
                              {exceeds ? <div className="invalid-feedback">Over outstanding</div> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="form-text mb-0">
                    <i className="bi bi-info-circle me-1" aria-hidden="true" />
                    <strong>Bounce charge</strong> is what has been assessed on the instalment. Enter under{' '}
                    <strong>Bounce collected</strong> only what the customer has actually paid towards it — it is saved as
                    part of this collection, taken out of the amount rather than added to it, and never allocated to an
                    instalment, so it cannot change any EMI balance, DPD or status.
                  </p>
                </div>
              )}

              {/*
                * The reconciliation, shown as the operator types:
                *   total received = allocated to instalments + bounce collected
                * Every rupee is in exactly one of the two, so nothing is double
                * counted and nothing is left unexplained.
                */}
              <div
                className={`alert ${
                  unallocatedMinor === 0 && amountMinor > 0 && !bounceOverAmount ? 'alert-success' : 'alert-warning'
                } mb-0`}
              >
                <div className="row g-2 small">
                  <div className="col-6 col-md-3">
                    <div className="text-uppercase fw-semibold">Total collection</div>
                    <div className="fw-bold">{formatCurrency(fromMinorUnits(amountMinor))}</div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="text-uppercase fw-semibold">EMI allocated</div>
                    <div className="fw-bold">{formatCurrency(fromMinorUnits(allocatedMinor))}</div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="text-uppercase fw-semibold">Bounce collection</div>
                    <div className="fw-bold">{formatCurrency(fromMinorUnits(bounceMinor))}</div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="text-uppercase fw-semibold">Unallocated</div>
                    <div className="fw-bold">{formatCurrency(fromMinorUnits(unallocatedMinor))}</div>
                  </div>
                </div>
                {bounceOverAmount ? (
                  <div className="mt-2">Bounce collection cannot be more than the amount received.</div>
                ) : null}
                {fieldErrors.allocations ? <div className="mt-2">{fieldErrors.allocations}</div> : null}
              </div>
            </>
          ) : null}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {submitting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Posting…
              </>
            ) : (
              'Post collection'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
