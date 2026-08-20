import { useEffect, useState } from 'react';
import Spinner from '../common/Spinner';
import EmiStatusBadge from './EmiStatusBadge';
import { formatCurrency } from '../../utils/loanConstants';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Same rule the backend validates: 0 or more, at most two decimals. */
const isValidCharge = (value) => /^\d+(\.\d{1,2})?$/.test(String(value).trim());

/**
 * One instalment's bounce-charge cell.
 *
 * Editable only where the caller supplies `onSave` and the viewer holds the
 * permission; otherwise it renders as plain text like every other column. The
 * input is seeded from the saved value and resets to it whenever the row is
 * reloaded, so an abandoned edit never lingers as if it had been stored.
 */
function BounceChargeCell({ emi, editable, onSave }) {
  const saved = emi.bounceCharge ?? '0.00';
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(saved);
    setError('');
  }, [saved]);

  if (!editable) {
    return <td className="text-end">{formatCurrency(saved)}</td>;
  }

  const dirty = String(draft).trim() !== String(saved).trim();

  const save = async () => {
    const value = String(draft).trim();
    if (!dirty) return;
    if (!isValidCharge(value)) {
      setError('0 or more, up to 2 decimals');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await onSave(emi, value);
    } catch (requestError) {
      setError(requestError.message || 'Could not save.');
      setDraft(saved);
    } finally {
      setSaving(false);
    }
  };

  return (
    <td className="text-end" style={{ minWidth: '9rem' }}>
      <div className="input-group input-group-sm">
        <input
          type="text"
          inputMode="decimal"
          className={`form-control text-end${error ? ' is-invalid' : ''}`}
          value={draft}
          disabled={saving}
          aria-label={`Bounce charge for EMI ${emi.emiNumber}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') {
              setDraft(saved);
              setError('');
            }
          }}
          onBlur={save}
        />
        {dirty ? (
          <button type="button" className="btn btn-outline-primary" onClick={save} disabled={saving} aria-label="Save bounce charge">
            <i className={`bi ${saving ? 'bi-hourglass-split' : 'bi-check-lg'}`} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {error ? <div className="form-text text-danger small text-end">{error}</div> : null}
    </td>
  );
}

/**
 * Instalment table.
 *
 * Everything here is read-only except the bounce charge — amount collected and
 * payment date are written by the collection module, and DPD is
 * system-calculated, so neither has an edit affordance. The bounce charge is a
 * manually recorded fee that sits beside the instalment: it is not added to the
 * EMI amount, the collected total or the outstanding balance, and no total in
 * this table includes it.
 */
export default function EmiScheduleTable({ emis = [], loading = false, error = '', canEditBounceCharge = false, onBounceChargeSave }) {
  if (loading) return <Spinner label="Loading EMI schedule…" />;
  if (error) return <div className="alert alert-danger">{error}</div>;

  if (emis.length === 0) {
    return <p className="text-secondary mb-0">No EMI schedule found for this loan.</p>;
  }

  const editable = canEditBounceCharge && typeof onBounceChargeSave === 'function';

  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle mb-0">
        <thead className="table-light">
          <tr>
            <th scope="col">#</th>
            <th scope="col">EMI date</th>
            <th scope="col" className="text-end">EMI amount</th>
            <th scope="col" className="text-end">Principal</th>
            <th scope="col" className="text-end">Interest</th>
            <th scope="col" className="text-end">Bounce charge</th>
            <th scope="col" className="text-end">DPD</th>
            <th scope="col" className="text-end">Collected</th>
            <th scope="col" className="text-end">Outstanding</th>
            <th scope="col">Payment date</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {emis.map((emi) => (
            <tr key={emi.id ?? emi.emiNumber}>
              <td className="fw-semibold">{emi.emiNumber}</td>
              <td>{formatDate(emi.emiDate)}</td>
              <td className="text-end">{formatCurrency(emi.emiAmount)}</td>
              <td className="text-end">{formatCurrency(emi.principal)}</td>
              <td className="text-end">{formatCurrency(emi.interest)}</td>
              <BounceChargeCell emi={emi} editable={editable} onSave={onBounceChargeSave} />
              <td className="text-end">
                {emi.dpd > 0 ? <span className="text-danger fw-semibold">{emi.dpd}</span> : <span className="text-secondary">0</span>}
              </td>
              <td className="text-end">{formatCurrency(emi.amountCollected)}</td>
              <td className="text-end">{formatCurrency(emi.outstanding)}</td>
              <td>{emi.paymentDate ? formatDate(emi.paymentDate) : <span className="text-secondary">—</span>}</td>
              <td>
                <EmiStatusBadge status={emi.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
