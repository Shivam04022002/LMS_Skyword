import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import PartySelector from '../loanParties/PartySelector';
import PartyCard from '../loanParties/PartyCard';
import { createLoan, updateLoan, previewLoanFinancials } from '../../services/loanService';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { toFieldErrors } from '../../utils/errorHandler';
import {
  LOAN_TYPES,
  PERIOD_LABELS,
  INTEREST_METHODS,
  INTEREST_METHOD_LABELS,
  INTEREST_METHOD_DESCRIPTIONS,
  WEEKLY_OFF_VALUES,
  WEEKLY_OFF_LABELS,
  supportsWeeklyOff,
  supportsMonthTenure,
  showsTenureUnitChoice,
  defaultTenureUnit,
  tenureUnitLabel,
  usesCollectionCount,
  collectionCountLabel,
  collectionCountHint,
  formatCurrency,
  titleCase
} from '../../utils/loanConstants';
import { PARTY_ROLES } from '../../utils/loanPartyConstants';

const EMPTY_TERMS = {
  loanAmount: '',
  roi: '',
  tenure: '',
  loanType: 'MONTHLY',
  startDate: '',
  interestMethod: 'FLAT',
  weeklyOff: 'NONE',
  tenureUnit: 'PERIODS',
  collectionCount: ''
};

function validate(terms, parties, mode) {
  const errors = {};

  if (!String(terms.loanAmount).trim()) errors.loanAmount = 'Loan amount is required';
  else if (!/^\d+(\.\d{1,2})?$/.test(String(terms.loanAmount)) || Number(terms.loanAmount) <= 0) {
    errors.loanAmount = 'Enter a positive amount with at most 2 decimals';
  }

  if (!String(terms.roi).trim()) errors.roi = 'ROI is required';
  else if (!/^\d+(\.\d{1,4})?$/.test(String(terms.roi)) || Number(terms.roi) > 100) {
    errors.roi = 'Enter a monthly percentage between 0 and 100';
  }

  if (!String(terms.tenure).trim()) errors.tenure = 'Tenure is required';
  else if (!/^\d+$/.test(String(terms.tenure)) || Number(terms.tenure) < 1) errors.tenure = 'Enter a whole number of periods';

  if (!terms.startDate) errors.startDate = 'Start date is required';

  if (usesCollectionCount(terms.loanType, terms.tenureUnit)) {
    if (!String(terms.collectionCount).trim()) errors.collectionCount = `${collectionCountLabel(terms.loanType)} is required`;
    else if (!/^\d+$/.test(String(terms.collectionCount)) || Number(terms.collectionCount) < 1) {
      errors.collectionCount = 'Enter a whole number, at least 1';
    }
  }

  if (mode === 'create' && !parties.applicant) errors.applicant = 'An applicant is required';

  return errors;
}

export default function LoanFormModal({ open, mode = 'create', loan = null, onClose, onSaved }) {
  const [terms, setTerms] = useState(EMPTY_TERMS);
  const [parties, setParties] = useState({ applicant: null, coApplicants: [], guarantors: [] });
  const [partyPicker, setPartyPicker] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const debouncedTerms = useDebouncedValue(terms, 500);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && loan) {
      setTerms({
        loanAmount: loan.loanAmount ?? '',
        roi: loan.roi ?? '',
        tenure: String(loan.tenure ?? ''),
        loanType: loan.loanType ?? 'MONTHLY',
        startDate: loan.startDate ? String(loan.startDate).slice(0, 10) : '',
        interestMethod: loan.interestMethod ?? 'FLAT',
        weeklyOff: loan.weeklyOff ?? 'NONE',
        tenureUnit: loan.tenureUnit ?? 'PERIODS',
        collectionCount:
          loan.collectionCount === null || loan.collectionCount === undefined ? '' : String(loan.collectionCount)
      });
    } else {
      setTerms({ ...EMPTY_TERMS, tenureUnit: defaultTenureUnit(EMPTY_TERMS.loanType) });
    }
    setParties({ applicant: null, coApplicants: [], guarantors: [] });
    setPartyPicker(null);
    setPreview(null);
    setFieldErrors({});
    setFormError('');
  }, [open, mode, loan]);

  // Preview comes from the backend, so it can never drift from stored values.
  useEffect(() => {
    if (!open) return undefined;

    const { loanAmount, roi, tenure, loanType, startDate, interestMethod, weeklyOff, tenureUnit, collectionCount } = debouncedTerms;
    if (!loanAmount || !roi || !tenure || !loanType) {
      setPreview(null);
      return undefined;
    }

    // Which days are Sundays depends on where the term starts, so the backend
    // cannot count chargeable days without it.
    // A month-based daily contract and a weekly off both need to know where the
    // term starts before the backend can price them.
    const needsStartDate = weeklyOff !== 'NONE' || (tenureUnit === 'MONTHS' && loanType !== 'MONTHLY');
    if (needsStartDate && !startDate) {
      setPreview(null);
      setPreviewError('Choose a start date to see the contractual period.');
      return undefined;
    }

    // The backend refuses a month-based daily loan without it, so there is
    // nothing to preview until it is filled in.
    const needsCollectionCount = usesCollectionCount(loanType, tenureUnit);
    if (needsCollectionCount && !/^\d+$/.test(String(collectionCount))) {
      setPreview(null);
      setPreviewError(`Enter the ${collectionCountLabel(loanType).toLowerCase()} to see the schedule.`);
      return undefined;
    }

    let cancelled = false;

    previewLoanFinancials({
      loanAmount,
      roi,
      tenure,
      loanType,
      startDate,
      interestMethod,
      weeklyOff,
      tenureUnit,
      ...(needsCollectionCount ? { collectionCount: Number(collectionCount) } : {}),
      // An existing loan is previewed on the basis it was priced with, so the
      // quoted figures always match what saving will store.
      ...(loan?.roiBasis ? { roiBasis: loan.roiBasis } : {})
    })
      .then((response) => {
        if (!cancelled) {
          setPreview(response.data.financials);
          setPreviewError('');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedTerms, open, loan]);

  const handleTermChange = (event) => {
    const { name, value } = event.target;
    setTerms((current) => ({
      ...current,
      [name]: value,
      // The backend rejects a weekly off on a non-daily loan, so the form drops
      // it rather than sending a combination that will be refused.
      ...(name === 'loanType' && !supportsWeeklyOff(value) ? { weeklyOff: 'NONE' } : {}),
      // Each frequency opens on the unit it is normally written in.
      ...(name === 'loanType' ? { tenureUnit: defaultTenureUnit(value) } : {}),
      // The field is not sent when it does not apply, so it must not linger.
      ...(name === 'loanType' ? { collectionCount: '' } : {}),
      ...(name === 'tenureUnit' && value !== 'MONTHS' ? { collectionCount: '' } : {})
    }));
    setFieldErrors((current) => ({ ...current, [name]: undefined }));
  };

  const attachedIds = [
    parties.applicant?.id,
    ...parties.coApplicants.map((customer) => customer.id),
    ...parties.guarantors.map((customer) => customer.id)
  ].filter(Boolean);

  const handleSelectCustomer = (customer) => {
    setParties((current) => {
      if (partyPicker === PARTY_ROLES.APPLICANT) return { ...current, applicant: customer };
      if (partyPicker === PARTY_ROLES.CO_APPLICANT) return { ...current, coApplicants: [...current.coApplicants, customer] };
      return { ...current, guarantors: [...current.guarantors, customer] };
    });
    setFieldErrors((current) => ({ ...current, applicant: undefined }));
    setPartyPicker(null);
  };

  const removeParty = (role, customerId) => {
    setParties((current) => {
      if (role === PARTY_ROLES.APPLICANT) return { ...current, applicant: null };
      if (role === PARTY_ROLES.CO_APPLICANT) {
        return { ...current, coApplicants: current.coApplicants.filter((c) => c.id !== customerId) };
      }
      return { ...current, guarantors: current.guarantors.filter((c) => c.id !== customerId) };
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    const errors = validate(terms, parties, mode);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      // Only borrower-facing terms are sent; totals and the loan number come
      // back from the backend, which is the sole authority on them.
      const payload = {
        loanAmount: terms.loanAmount,
        roi: terms.roi,
        tenure: Number(terms.tenure),
        loanType: terms.loanType,
        startDate: terms.startDate,
        interestMethod: terms.interestMethod,
        weeklyOff: terms.weeklyOff,
        tenureUnit: terms.tenureUnit,
        // Only ever sent for a loan that collects in days and is written in months.
        ...(usesCollectionCount(terms.loanType, terms.tenureUnit)
          ? { collectionCount: Number(terms.collectionCount) }
          : {})
      };

      if (mode === 'create') {
        const response = await createLoan({
          ...payload,
          applicantCustomerId: parties.applicant.id,
          coApplicantCustomerIds: parties.coApplicants.map((customer) => customer.id),
          guarantorCustomerIds: parties.guarantors.map((customer) => customer.id)
        });
        onSaved({ mode: 'create', loan: response.data.loan });
      } else {
        const response = await updateLoan(loan.id, payload);
        onSaved({ mode: 'edit', loan: response.data.loan });
      }
    } catch (error) {
      setFormError(error.message);
      setFieldErrors(toFieldErrors(error));
    } finally {
      setSubmitting(false);
    }
  };

  const periodLabel = tenureUnitLabel(terms.loanType, terms.tenureUnit);
  // Loans created before rates became monthly keep their annual meaning.
  const isLegacyAnnualRate = mode === 'edit' && loan?.roiBasis === 'ANNUAL';

  const asPartyShape = (customer, role) => ({
    id: customer.id,
    partyRole: role,
    status: 'ACTIVE',
    customer
  });

  return (
    <Modal
      title={mode === 'create' ? 'New loan' : `Edit loan ${loan?.loanNumber ?? ''}`}
      open={open}
      onClose={submitting ? () => {} : onClose}
      size="modal-lg"
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="modal-body">
          <AlertMessage message={formError} onDismiss={() => setFormError('')} />

          <h3 className="h6 fw-bold text-uppercase text-secondary small mb-2">Terms</h3>
          <div className="row g-3 mb-4">
            <div className="col-12 col-md-4">
              <label className="form-label small fw-semibold" htmlFor="loan-amount">
                Loan amount <span className="text-danger">*</span>
              </label>
              <input
                id="loan-amount"
                name="loanAmount"
                className={`form-control${fieldErrors.loanAmount ? ' is-invalid' : ''}`}
                value={terms.loanAmount}
                onChange={handleTermChange}
                inputMode="decimal"
                disabled={submitting}
              />
              <div className="invalid-feedback">{fieldErrors.loanAmount}</div>
            </div>

            <div className="col-6 col-md-4">
              <label className="form-label small fw-semibold" htmlFor="loan-roi">
                ROI % per month <span className="text-danger">*</span>
              </label>
              <input
                id="loan-roi"
                name="roi"
                className={`form-control${fieldErrors.roi ? ' is-invalid' : ''}`}
                value={terms.roi}
                onChange={handleTermChange}
                inputMode="decimal"
                placeholder="1.50"
                disabled={submitting}
              />
              <div className="invalid-feedback">{fieldErrors.roi}</div>
              <div className="form-text">
                {isLegacyAnnualRate
                  ? 'This loan was priced on an annual rate and keeps that meaning.'
                  : 'Interest rate charged per month.'}
              </div>
            </div>

            <div className="col-6 col-md-4">
              <label className="form-label small fw-semibold" htmlFor="loan-type">
                Loan type <span className="text-danger">*</span>
              </label>
              <select
                id="loan-type"
                name="loanType"
                className="form-select"
                value={terms.loanType}
                onChange={handleTermChange}
                disabled={submitting}
              >
                {LOAN_TYPES.map((type) => (
                  <option value={type} key={type}>
                    {titleCase(type)}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-6 col-md-4">
              <label className="form-label small fw-semibold" htmlFor="loan-tenure">
                Tenure ({periodLabel}) <span className="text-danger">*</span>
              </label>
              <div className="input-group">
                <input
                  id="loan-tenure"
                  name="tenure"
                  className={`form-control${fieldErrors.tenure ? ' is-invalid' : ''}`}
                  value={terms.tenure}
                  onChange={handleTermChange}
                  inputMode="numeric"
                  disabled={submitting}
                />
                {showsTenureUnitChoice(terms.loanType) ? (
                  <select
                    id="loan-tenure-unit"
                    name="tenureUnit"
                    className="form-select"
                    style={{ maxWidth: '9rem' }}
                    value={terms.tenureUnit}
                    onChange={handleTermChange}
                    disabled={submitting}
                    aria-label="Tenure unit"
                  >
                    <option value="PERIODS">{PERIOD_LABELS[terms.loanType] ?? 'periods'}</option>
                    <option value="MONTHS">months</option>
                  </select>
                ) : null}
              </div>
              <div className="invalid-feedback d-block">{fieldErrors.tenure}</div>
              <div className="form-text">
                {terms.tenureUnit === 'MONTHS'
                  ? 'A contract of whole months. Interest is charged for the months agreed, and collection runs inside that period.'
                  : `Number of ${periodLabel}.`}
              </div>
            </div>

            <div className="col-6 col-md-4">
              <label className="form-label small fw-semibold" htmlFor="loan-start">
                Start date <span className="text-danger">*</span>
              </label>
              <input
                id="loan-start"
                name="startDate"
                type="date"
                className={`form-control${fieldErrors.startDate ? ' is-invalid' : ''}`}
                value={terms.startDate}
                onChange={handleTermChange}
                disabled={submitting}
              />
              <div className="invalid-feedback">{fieldErrors.startDate}</div>
            </div>

            <div className="col-12 col-md-4">
              <label className="form-label small fw-semibold" htmlFor="loan-interest-method">
                ROI method <span className="text-danger">*</span>
              </label>
              <select
                id="loan-interest-method"
                name="interestMethod"
                className={`form-select${fieldErrors.interestMethod ? ' is-invalid' : ''}`}
                value={terms.interestMethod}
                onChange={handleTermChange}
                disabled={submitting}
              >
                {INTEREST_METHODS.map((method) => (
                  <option value={method} key={method}>
                    {INTEREST_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
              <div className="invalid-feedback">{fieldErrors.interestMethod}</div>
              <div className="form-text">{INTEREST_METHOD_DESCRIPTIONS[terms.interestMethod]}</div>
            </div>

            {supportsWeeklyOff(terms.loanType) ? (
              <div className="col-12 col-md-8">
                <label className="form-label small fw-semibold" htmlFor="loan-weekly-off">
                  Weekly off
                </label>
                <select
                  id="loan-weekly-off"
                  name="weeklyOff"
                  className={`form-select${fieldErrors.weeklyOff ? ' is-invalid' : ''}`}
                  value={terms.weeklyOff}
                  onChange={handleTermChange}
                  disabled={submitting}
                >
                  {WEEKLY_OFF_VALUES.map((value) => (
                    <option value={value} key={value}>
                      {WEEKLY_OFF_LABELS[value]}
                    </option>
                  ))}
                </select>
                <div className="invalid-feedback">{fieldErrors.weeklyOff}</div>
                <div className="form-text">
                  Excluded days carry no instalment and no interest. The term still ends after the tenure you entered —
                  it is not extended to make the days up.
                </div>
              </div>
            ) : null}

            {usesCollectionCount(terms.loanType, terms.tenureUnit) ? (
              <div className="col-12 col-md-4">
                <label className="form-label small fw-semibold" htmlFor="loan-collection-count">
                  {collectionCountLabel(terms.loanType)} <span className="text-danger">*</span>
                </label>
                <input
                  id="loan-collection-count"
                  name="collectionCount"
                  className={`form-control${fieldErrors.collectionCount ? ' is-invalid' : ''}`}
                  value={terms.collectionCount}
                  onChange={handleTermChange}
                  inputMode="numeric"
                  min="1"
                  placeholder={terms.loanType === 'DAILY' ? '150' : terms.loanType === 'WEEKLY' ? '26' : '13'}
                  disabled={submitting}
                />
                <div className="invalid-feedback">{fieldErrors.collectionCount}</div>
                <div className="form-text">
                  {collectionCountHint(terms.loanType)} The collections must finish by the contractual end date.
                </div>
              </div>
            ) : null}
          </div>

          <div className="card bg-light border-0 mb-4">
            <div className="card-body py-3">
              <h3 className="h6 fw-bold mb-2">
                Calculated by the system
                <span className="badge text-bg-secondary ms-2 fw-normal">preview</span>
              </h3>
              {previewError ? (
                <p className="text-danger small mb-0">{previewError}</p>
              ) : preview ? (
                <div className="row g-3 small">
                  <div className="col-12 text-secondary">
                    <i className="bi bi-info-circle me-1" aria-hidden="true" />
                    {INTEREST_METHOD_DESCRIPTIONS[preview.interestMethod] ?? ''}
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="text-secondary">Interest</div>
                    <div className="fw-semibold">{formatCurrency(preview.interest)}</div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="text-secondary">Total repayment</div>
                    <div className="fw-semibold">{formatCurrency(preview.totalRepayment)}</div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="text-secondary">EMI amount</div>
                    <div className="fw-semibold">{formatCurrency(preview.emiAmount)}</div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="text-secondary">EMI count</div>
                    <div className="fw-semibold">{preview.emiCount}</div>
                  </div>
                  {preview.startDate && preview.endDate ? (
                    <div className="col-12 col-md-6">
                      <div className="text-secondary">Contractual period</div>
                      <div className="fw-semibold">
                        {preview.startDate} to {preview.endDate}
                        {preview.tenureUnit === 'MONTHS' ? (
                          <span className="text-secondary fw-normal"> — {preview.termMonths} months</span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {preview.calendarDays ? (
                    <div className="col-12 col-md-6">
                      <div className="text-secondary">Collection schedule</div>
                      <div className="fw-semibold">
                        {preview.collectionCount
                          ? `${preview.collectionCount} collections`
                          : `${preview.chargeableDays} chargeable days / ${preview.calendarDays} calendar days`}
                        {preview.lastCollectionDate ? (
                          <span className="text-secondary fw-normal"> — last collection {preview.lastCollectionDate}</span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {preview.roundingRemainder && Number(preview.roundingRemainder) !== 0 ? (
                    <div className="col-12 text-secondary">
                      Final instalment {formatCurrency(preview.lastEmiAmount)} absorbs a{' '}
                      {formatCurrency(preview.roundingRemainder)} rounding difference.
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-secondary small mb-0">Fill in the terms to see the calculated repayment.</p>
              )}
            </div>
          </div>

          {mode === 'create' ? (
            <>
              <h3 className="h6 fw-bold text-uppercase text-secondary small mb-2">Parties</h3>
              {fieldErrors.applicant ? <p className="text-danger small">{fieldErrors.applicant}</p> : null}

              <div className="row g-3">
                {[
                  { role: PARTY_ROLES.APPLICANT, label: 'Applicant', items: parties.applicant ? [parties.applicant] : [] },
                  { role: PARTY_ROLES.CO_APPLICANT, label: 'Co-applicants', items: parties.coApplicants },
                  { role: PARTY_ROLES.GUARANTOR, label: 'Guarantors', items: parties.guarantors }
                ].map(({ role, label, items }) => (
                  <div className="col-12" key={role}>
                    <div className="d-flex align-items-center justify-content-between mb-2">
                      <span className="fw-semibold small">
                        {label}
                        {role === PARTY_ROLES.APPLICANT ? <span className="text-danger"> *</span> : null}
                      </span>
                      {role === PARTY_ROLES.APPLICANT && parties.applicant ? null : (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary"
                          onClick={() => setPartyPicker(partyPicker === role ? null : role)}
                          disabled={submitting}
                        >
                          <i className="bi bi-plus-lg me-1" aria-hidden="true" />
                          Add
                        </button>
                      )}
                    </div>

                    <div className="row g-2">
                      {items.map((customer) => (
                        <div className="col-12 col-md-6" key={customer.id}>
                          <PartyCard
                            party={asPartyShape(customer, role)}
                            compact
                            actions={[
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-danger"
                                key="remove"
                                onClick={() => removeParty(role, customer.id)}
                                disabled={submitting}
                              >
                                Remove
                              </button>
                            ]}
                          />
                        </div>
                      ))}
                    </div>

                    {partyPicker === role ? (
                      <div className="border rounded p-3 mt-2">
                        <PartySelector onSelect={handleSelectCustomer} excludeCustomerIds={attachedIds} autoFocus />
                        <button type="button" className="btn btn-sm btn-link" onClick={() => setPartyPicker(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-secondary small mb-0">
              Parties are managed from the loan details page. Only a DRAFT loan&apos;s terms can be edited here.
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Saving…
              </>
            ) : mode === 'create' ? (
              'Create loan'
            ) : (
              'Save changes'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
