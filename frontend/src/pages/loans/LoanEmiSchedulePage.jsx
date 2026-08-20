import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Pagination from '../../components/common/Pagination';
import EmiScheduleTable from '../../components/emis/EmiScheduleTable';
import EmiSummary from '../../components/emis/EmiSummary';
import usePermissions from '../../hooks/usePermissions';
import { getEmiSchedule, generateEmiSchedule, recalculateEmiSnapshots, updateEmiBounceCharge } from '../../services/emiService';
import { getLoan } from '../../services/loanService';
import { PERMISSIONS } from '../../utils/permissions';
import { EMI_STATUSES } from '../../utils/emiConstants';

const PAGE_SIZE = 100;

export default function LoanEmiSchedulePage() {
  const { id } = useParams();
  const { can } = usePermissions();

  const [loan, setLoan] = useState(null);
  const [emis, setEmis] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 });
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [loanResponse, scheduleResponse] = await Promise.all([
        getLoan(id),
        getEmiSchedule(id, { status: statusFilter, page, limit: PAGE_SIZE })
      ]);
      setLoan(loanResponse.data.loan);
      setEmis(scheduleResponse.data.emis);
      setSummary(scheduleResponse.data.summary);
      setPagination(scheduleResponse.data.pagination);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the EMI schedule.');
      setEmis([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [id, statusFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const handleGenerate = async () => {
    setBusy(true);
    setError('');
    try {
      await generateEmiSchedule(id);
      setNotice('EMI schedule generated.');
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRecalculate = async () => {
    setBusy(true);
    setError('');
    try {
      await recalculateEmiSnapshots(id);
      setNotice('DPD and status snapshots recalculated.');
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Saves one instalment's bounce charge and patches that row in place.
   *
   * No reload: nothing else on the schedule can have changed, and a full reload
   * would throw away the operator's position in a long table. The error is
   * rethrown so the cell can show it against the input it belongs to.
   */
  const handleBounceChargeSave = async (emi, bounceCharge) => {
    setError('');
    const response = await updateEmiBounceCharge(id, emi.id, bounceCharge);
    const saved = response.data.emi;
    setEmis((current) => current.map((row) => (row.id === saved.id ? saved : row)));
    setNotice(`Bounce charge saved on EMI #${saved.emiNumber}.`);
  };

  const hasSchedule = summary?.emiCount > 0;
  const canGenerate = can(PERMISSIONS.EMIS_GENERATE) && loan?.status === 'ACTIVE' && !hasSchedule;

  return (
    <div className="container-fluid px-0">
      <Link className="btn btn-sm btn-outline-secondary mb-3" to={`/loans/${id}`}>
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        Back to loan
      </Link>

      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">EMI schedule</h1>
          <p className="text-secondary mb-0">
            {loan ? (
              <>
                <span className="font-monospace">{loan.loanNumber}</span> · {loan.status}
              </>
            ) : (
              'Loan instalments'
            )}
          </p>
        </div>

        <div className="d-flex gap-2">
          {canGenerate ? (
            <button type="button" className="btn btn-primary" onClick={handleGenerate} disabled={busy}>
              <i className="bi bi-calendar-plus me-2" aria-hidden="true" />
              Generate schedule
            </button>
          ) : null}
          {hasSchedule && can(PERMISSIONS.EMIS_UPDATE) ? (
            <button type="button" className="btn btn-outline-secondary" onClick={handleRecalculate} disabled={busy}>
              <i className="bi bi-arrow-clockwise me-2" aria-hidden="true" />
              Recalculate DPD
            </button>
          ) : null}
        </div>
      </div>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      {summary ? (
        <div className="mb-4">
          <EmiSummary summary={summary} />
        </div>
      ) : null}

      <div className="card border-0 shadow-sm">
        <div className="card-body pb-0">
          <div className="row g-2 align-items-end mb-3">
            <div className="col-12 col-md-3">
              <label className="form-label small fw-semibold" htmlFor="emi-status-filter">
                Status
              </label>
              <select
                id="emi-status-filter"
                className="form-select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="">All statuses</option>
                {EMI_STATUSES.map((status) => (
                  <option value={status} key={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <EmiScheduleTable
          emis={emis}
          loading={loading}
          error=""
          canEditBounceCharge={can(PERMISSIONS.EMIS_BOUNCE_CHARGE)}
          onBounceChargeSave={handleBounceChargeSave}
        />

        {!loading && emis.length > 0 ? (
          <div className="card-footer bg-white border-top">
            <Pagination {...pagination} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <p className="form-text mt-3">
        Amount collected and payment dates are recorded by the collection module. DPD is calculated by the system and
        cannot be edited. A bounce charge is recorded by hand and is kept separate from the instalment: it is not part of
        the EMI amount, the collected total or the outstanding balance.
      </p>
    </div>
  );
}
