import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import LoanStatusBadge from '../../components/loans/LoanStatusBadge';
import LoanFormModal from '../../components/loans/LoanFormModal';
import PartyList from '../../components/loanParties/PartyList';
import PartyFormModal from '../../components/loanParties/PartyFormModal';
import SwapApplicantModal from '../../components/loanParties/SwapApplicantModal';
import LoanStatusConfirmModal from '../../components/loans/LoanStatusConfirmModal';
import usePermissions from '../../hooks/usePermissions';
import { getLoan, updateLoanStatus } from '../../services/loanService';
import { getLoanParties, setLoanPartyStatus } from '../../services/loanPartyService';
import { getEmiSchedule } from '../../services/emiService';
import EmiSummary from '../../components/emis/EmiSummary';
import { PERMISSIONS } from '../../utils/permissions';
import {
  ALLOWED_TRANSITIONS,
  EDITABLE_STATUSES,
  PERIOD_LABELS,
  tenureUnitLabel,
  collectionCountLabel,
  INTEREST_METHOD_LABELS,
  INTEREST_METHOD_DESCRIPTIONS,
  formatCurrency,
  formatRoi,
  titleCase
} from '../../utils/loanConstants';

const TRANSITION_PERMISSION = {
  ACTIVE: PERMISSIONS.LOANS_ACTIVATE,
  CLOSED: PERMISSIONS.LOANS_CLOSE,
  CANCELLED: PERMISSIONS.LOANS_CANCEL
};

/*
 * The action names the loan, not the page. "Close" and "Cancel" alone read as
 * window controls, and both were previously a single click away from changing a
 * loan's status for good.
 *
 * The icon is not decoration: it is the second, non-colour signal separating a
 * routine close from a destructive cancel.
 */
const TRANSITION_ACTION = {
  ACTIVE: { label: 'Activate', icon: 'bi-play-circle', className: 'btn-primary', hint: 'Activate this loan and generate its EMI schedule' },
  CLOSED: { label: 'Close Loan', icon: 'bi-check-circle', className: 'btn-primary', menuClassName: '', hint: 'Mark this loan closed — final, and it stops further collections' },
  CANCELLED: { label: 'Cancel Loan', icon: 'bi-x-circle', className: 'btn-outline-danger', menuClassName: 'text-danger', hint: 'Cancel this loan — final, and it stops further collections' }
};

/** Status changes serious enough to require an explicit confirmation. */
const CONFIRMED_TRANSITIONS = ['CLOSED', 'CANCELLED'];

/*
 * The two terminal actions live behind the three-dot menu rather than sitting
 * in the header. Both are irreversible, and neither is a routine part of
 * viewing a loan, so they are one deliberate step further away from a stray
 * click. Activate stays a visible button: it is the ordinary next step on a
 * draft loan, and is unchanged by this.
 *
 * The confirmation dialog still stands between the menu item and the API, so
 * moving them here reduces exposure without becoming the only safeguard.
 */
const MENU_TRANSITIONS = ['CLOSED', 'CANCELLED'];

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

export default function LoanDetailsPage() {
  const { id } = useParams();
  const { can } = usePermissions();

  const [loan, setLoan] = useState(null);
  const [parties, setParties] = useState([]);
  const [emiSummary, setEmiSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  // `null` closed; otherwise the party being edited, or 'add' for a new one.
  const [partyForm, setPartyForm] = useState(null);
  // The status awaiting confirmation, or null when no dialog is open. Holding
  // the target status here is what keeps Close and Cancel from ever being able
  // to trigger one another.
  const [pendingTransition, setPendingTransition] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const loanResponse = await getLoan(id);
      setLoan(loanResponse.data.loan);

      // Parties are re-read from their own endpoint so the list always reflects
      // the backend rather than a stale copy embedded in the loan payload.
      if (can(PERMISSIONS.LOAN_PARTIES_VIEW)) {
        const partiesResponse = await getLoanParties(id);
        setParties(partiesResponse.data.parties);
      }

      // A loan only has a schedule once it is activated, so an empty result here
      // is a normal state rather than an error.
      if (can(PERMISSIONS.EMIS_VIEW)) {
        const scheduleResponse = await getEmiSchedule(id, { limit: 1 });
        setEmiSummary(scheduleResponse.data.summary);
      }
    } catch (requestError) {
      setError(requestError.message || 'Unable to load this loan.');
      setLoan(null);
    } finally {
      setLoading(false);
    }
  }, [id, can]);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * Performs the status change. Confirmed transitions are called by the dialog,
   * which keeps itself open and shows the backend's own message if this throws
   * — the loan may no longer be eligible, and that is the backend's call to
   * make, not something the page should guess at.
   *
   * The success notice is only shown once the request has resolved, and the
   * loan is then re-read so the badge and available actions reflect the server.
   */
  const handleTransition = async (status) => {
    setBusy(true);
    setError('');
    try {
      await updateLoanStatus(id, status);
      setPendingTransition(null);
      setNotice(`Loan ${status.toLowerCase()}.`);
      await load();
    } catch (requestError) {
      // Unconfirmed transitions have no dialog to display the error, so those
      // fall back to the page-level alert.
      if (!CONFIRMED_TRANSITIONS.includes(status)) setError(requestError.message);
      throw requestError;
    } finally {
      setBusy(false);
    }
  };

  /** A confirmed transition opens its dialog; anything else runs as before. */
  const requestTransition = (status) => {
    if (CONFIRMED_TRANSITIONS.includes(status)) {
      setPendingTransition(status);
      return;
    }
    handleTransition(status).catch(() => {});
  };

  const handleRemoveParty = async (party) => {
    setBusy(true);
    setError('');
    try {
      await setLoanPartyStatus(id, party.id, 'REMOVED');
      setNotice('Party removed from the loan.');
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading loan…" />;

  /*
   * What this loan's status allows, narrowed to what the caller may actually
   * do. The backend re-checks both on every request; hiding an action here is
   * convenience, never the control.
   */
  const transitions = loan ? (ALLOWED_TRANSITIONS[loan.status] ?? []).filter((status) => can(TRANSITION_PERMISSION[status])) : [];
  const inlineTransitions = transitions.filter((status) => !MENU_TRANSITIONS.includes(status));
  const menuTransitions = transitions.filter((status) => MENU_TRANSITIONS.includes(status));
  const editable = loan && EDITABLE_STATUSES.includes(loan.status) && can(PERMISSIONS.LOANS_UPDATE);

  return (
    <div className="container-fluid px-0">
      <Link className="btn btn-sm btn-outline-secondary mb-3" to="/loans">
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        Back to loans
      </Link>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      {loan ? (
        <>
          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body d-flex flex-wrap align-items-center justify-content-between gap-3">
              <div>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <span className="badge text-bg-light border font-monospace fs-6">{loan.loanNumber}</span>
                  <LoanStatusBadge status={loan.status} size="lg" />
                </div>
                <h1 className="h3 fw-bold mb-0">{formatCurrency(loan.loanAmount)}</h1>
              </div>

              <div className="d-flex flex-wrap gap-2" role="group" aria-label="Loan actions">
                {editable ? (
                  <button type="button" className="btn btn-outline-primary" onClick={() => setEditOpen(true)}>
                    <i className="bi bi-pencil me-2" aria-hidden="true" />
                    Edit terms
                  </button>
                ) : null}
                {inlineTransitions.map((status) => {
                  const action = TRANSITION_ACTION[status];
                  return (
                    <button
                      key={status}
                      type="button"
                      className={`btn ${action.className}`}
                      onClick={() => requestTransition(status)}
                      disabled={busy}
                      title={action.hint}
                    >
                      <i className={`bi ${action.icon} me-2`} aria-hidden="true" />
                      {action.label}
                    </button>
                  );
                })}

                {/*
                  * Bootstrap's own dropdown, the same one the header user menu
                  * uses. Its JS is already bundled, so dismissing on outside
                  * click, on Escape and on choosing an item, the arrow-key
                  * navigation and the aria-expanded state all come with it
                  * rather than being reimplemented here.
                  *
                  * Rendered only when the loan's status and the caller's
                  * permissions leave at least one action available, so an empty
                  * menu can never appear.
                  */}
                {menuTransitions.length > 0 ? (
                  <div className="dropdown">
                    <button
                      type="button"
                      id="loan-actions-menu"
                      className="btn btn-outline-secondary"
                      data-bs-toggle="dropdown"
                      aria-expanded="false"
                      aria-label="More loan actions"
                      title="More loan actions"
                      disabled={busy}
                    >
                      <i className="bi bi-three-dots-vertical" aria-hidden="true" />
                    </button>

                    <ul className="dropdown-menu dropdown-menu-end shadow-sm" aria-labelledby="loan-actions-menu">
                      {menuTransitions.map((status) => {
                        const action = TRANSITION_ACTION[status];
                        return (
                          <li key={status}>
                            <button
                              type="button"
                              className={`dropdown-item ${action.menuClassName}`.trim()}
                              // Stops the click reaching the surrounding card.
                              onClick={(event) => {
                                event.stopPropagation();
                                requestTransition(status);
                              }}
                              disabled={busy}
                              title={action.hint}
                            >
                              <i className={`bi ${action.icon} me-2`} aria-hidden="true" />
                              {action.label}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
            {!editable && loan.status !== 'DRAFT' ? (
              <div className="card-footer bg-white text-secondary small">
                <i className="bi bi-lock me-1" aria-hidden="true" />
                {loan.status === 'ACTIVE'
                  ? 'This loan is active — its terms are fixed and cannot be edited.'
                  : `This loan is ${loan.status.toLowerCase()} and is read-only.`}
              </div>
            ) : null}
          </div>

          <div className="row g-4 mb-4">
            <div className="col-12 col-lg-6">
              <div className="card border-0 shadow-sm h-100">
                <div className="card-body">
                  <h2 className="h6 fw-bold mb-3">
                    <i className="bi bi-cash-coin me-2 text-primary" aria-hidden="true" />
                    Terms
                  </h2>
                  <dl className="row mb-0">
                    <Row label="Loan amount">{formatCurrency(loan.loanAmount)}</Row>
                    <Row label="ROI">{formatRoi(loan.roi, loan.roiBasis)}</Row>
                    <Row label="Loan type">{titleCase(loan.loanType)}</Row>
                    <Row label="Tenure">
                      {loan.tenure} {tenureUnitLabel(loan.loanType, loan.tenureUnit)}
                    </Row>
                    <Row label="ROI method">
                      {INTEREST_METHOD_LABELS[loan.interestMethod] ?? loan.interestMethod}
                      <span className="d-block text-secondary small">
                        {INTEREST_METHOD_DESCRIPTIONS[loan.interestMethod] ?? ''}
                      </span>
                    </Row>
                    {loan.collectionCount ? (
                      <Row label={collectionCountLabel(loan.loanType)}>
                        {loan.collectionCount} collections
                        <span className="d-block text-secondary small">
                          Instalments that repay the contract, not calendar days.
                        </span>
                      </Row>
                    ) : null}
                    {loan.calendarDays ? (
                      <Row label="Chargeable days">
                        {loan.chargeableDays} chargeable days / {loan.calendarDays} calendar days
                        {loan.weeklyOff && loan.weeklyOff !== 'NONE' ? (
                          <span className="d-block text-secondary small">
                            No collection on {titleCase(loan.weeklyOff)}s — {loan.calendarDays - loan.chargeableDays}{' '}
                            excluded.
                          </span>
                        ) : null}
                      </Row>
                    ) : null}
                    <Row label="Start date">{formatDate(loan.startDate)}</Row>
                    {loan.endDate ? <Row label="End date">{formatDate(loan.endDate)}</Row> : null}
                  </dl>
                </div>
              </div>
            </div>

            <div className="col-12 col-lg-6">
              <div className="card border-0 shadow-sm h-100">
                <div className="card-body">
                  <h2 className="h6 fw-bold mb-3">
                    <i className="bi bi-calculator me-2 text-primary" aria-hidden="true" />
                    Repayment
                  </h2>
                  <dl className="row mb-0">
                    <Row label="Total repayment">{formatCurrency(loan.totalRepayment)}</Row>
                    <Row label="EMI amount">{formatCurrency(loan.emiAmount)}</Row>
                    <Row label="EMI count">{loan.emiCount}</Row>
                  </dl>
                  {can(PERMISSIONS.EMIS_VIEW) ? (
                    <Link className="btn btn-sm btn-outline-primary mt-3" to={`/loans/${id}/emis`}>
                      <i className="bi bi-list-ol me-1" aria-hidden="true" />
                      View EMI schedule
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          {can(PERMISSIONS.EMIS_VIEW) && emiSummary?.emiCount > 0 ? (
            <div className="mb-4">
              <div className="d-flex align-items-center justify-content-between mb-3">
                <h2 className="h5 fw-bold mb-0">EMI schedule</h2>
                <Link className="btn btn-sm btn-outline-primary" to={`/loans/${id}/emis`}>
                  Open full schedule
                </Link>
              </div>
              <EmiSummary summary={emiSummary} />
            </div>
          ) : null}

          {can(PERMISSIONS.LOAN_PARTIES_VIEW) ? (
            <div className="card border-0 shadow-sm mb-4">
              <div className="card-body">
                <PartyList
                  parties={parties}
                  onAdd={() => setPartyForm('add')}
                  onEdit={(party) => setPartyForm(party)}
                  onRemove={handleRemoveParty}
                  onSwap={() => setSwapOpen(true)}
                  busyPartyId={busy ? -1 : null}
                />
              </div>
            </div>
          ) : null}

          <div className="card border-0 shadow-sm">
            <div className="card-body">
              <h2 className="h6 fw-bold mb-3">
                <i className="bi bi-info-circle me-2 text-primary" aria-hidden="true" />
                System information
              </h2>
              <dl className="row mb-0">
                <Row label="Created by">{loan.createdBy?.name}</Row>
                <Row label="Created">{loan.createdAt ? new Date(loan.createdAt).toLocaleString() : null}</Row>
                <Row label="Updated by">{loan.updatedBy?.name}</Row>
                <Row label="Updated">{loan.updatedAt ? new Date(loan.updatedAt).toLocaleString() : null}</Row>
              </dl>
            </div>
          </div>

          {/*
            * One dialog instance, driven by which status is pending. Close and
            * Cancel therefore cannot be confirmed into one another: the status
            * the dialog confirms is the status the button set.
            */}
          <LoanStatusConfirmModal
            open={Boolean(pendingTransition)}
            status={pendingTransition}
            loan={loan}
            onDismiss={() => setPendingTransition(null)}
            onConfirm={handleTransition}
          />

          <LoanFormModal
            open={editOpen}
            mode="edit"
            loan={loan}
            onClose={() => setEditOpen(false)}
            onSaved={async () => {
              setEditOpen(false);
              setNotice('Loan updated successfully.');
              await load();
            }}
          />

          <PartyFormModal
            open={partyForm !== null}
            mode={partyForm === 'add' ? 'add' : 'edit'}
            loanId={id}
            party={partyForm === 'add' ? null : partyForm}
            parties={parties}
            onClose={() => setPartyForm(null)}
            onSaved={async ({ mode }) => {
              setPartyForm(null);
              setNotice(mode === 'edit' ? 'Party role updated.' : 'Party added to the loan.');
              // Re-read from the API rather than patching local state, so the
              // list always reflects what the backend actually stored.
              await load();
            }}
          />

          <SwapApplicantModal
            open={swapOpen}
            loanId={id}
            parties={parties}
            onClose={() => setSwapOpen(false)}
            onSwapped={async () => {
              setSwapOpen(false);
              setNotice('Applicant and co-applicant swapped.');
              await load();
            }}
          />
        </>
      ) : null}
    </div>
  );
}
