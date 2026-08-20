import { useEffect, useRef, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import Spinner from '../common/Spinner';
import { previewLoanImport, runLoanImport, downloadLoanImportTemplate } from '../../services/loanService';
import { formatCurrency } from '../../utils/loanConstants';

const MAX_PREVIEW_ROWS = 100;

const STATUS_BADGE = {
  VALID: 'text-bg-success',
  INVALID: 'text-bg-danger',
  DUPLICATE: 'text-bg-warning'
};

const STATUS_LABEL = {
  VALID: 'Will import',
  INVALID: 'Rejected',
  DUPLICATE: 'Duplicate in file'
};

/**
 * Bulk loan import: upload, preview, confirm, summary.
 *
 * Nothing here calculates money. The workbook carries terms only; the backend
 * prices every row with the same services the loan form uses and returns the
 * figures shown below. Confirming re-sends the same file to the import
 * endpoint, which re-validates from scratch — the preview is information, never
 * an instruction.
 *
 * A loan import is all or nothing: the backend refuses the whole file if any
 * row is unusable, so the confirm button stays disabled until every row passes.
 */
export default function LoanImportModal({ open, onClose, onImported }) {
  const inputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreview(null);
    setResult(null);
    setBusy('');
    setError('');
    if (inputRef.current) inputRef.current.value = '';
  }, [open]);

  const handleTemplate = async () => {
    setError('');
    setBusy('template');
    try {
      await downloadLoanImportTemplate();
    } catch (requestError) {
      setError(requestError.message || 'The template could not be downloaded.');
    } finally {
      setBusy('');
    }
  };

  const handleFile = async (event) => {
    const chosen = event.target.files?.[0] ?? null;
    setFile(chosen);
    setPreview(null);
    setResult(null);
    setError('');
    if (!chosen) return;

    setBusy('preview');
    try {
      const response = await previewLoanImport(chosen);
      setPreview(response.data);
    } catch (requestError) {
      setError(requestError.message || 'That file could not be read.');
      setPreview(null);
    } finally {
      setBusy('');
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setError('');
    setBusy('import');
    try {
      const response = await runLoanImport(file);
      setResult(response.data);
      setPreview(null);
      await onImported?.(response.data);
    } catch (requestError) {
      setError(requestError.message || 'The import could not be completed.');
    } finally {
      setBusy('');
    }
  };

  const summary = preview?.summary ?? result?.summary ?? null;
  const rows = preview?.rows ?? [];
  const allValid = Boolean(summary) && summary.totalRows > 0 && summary.validRows === summary.totalRows;
  const canImport = Boolean(file) && allValid && !busy && !result;

  return (
    <Modal title="Bulk import loans" open={open} onClose={busy ? () => {} : onClose} size="modal-xl">
      <div className="modal-body">
        <AlertMessage message={error} onDismiss={() => setError('')} />

        <div className="d-flex flex-wrap align-items-end justify-content-between gap-3 mb-3">
          <div className="flex-grow-1">
            <label className="form-label small fw-semibold" htmlFor="loan-import-file">
              Excel file (.xlsx)
            </label>
            <input
              id="loan-import-file"
              ref={inputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="form-control"
              onChange={handleFile}
              disabled={Boolean(busy)}
            />
            <div className="form-text">
              Terms only. Interest, repayment, EMI and the schedule are calculated by the system — a file containing a
              column for them is refused. Imported loans are created active with their schedule generated.
            </div>
          </div>
          <button type="button" className="btn btn-outline-secondary" onClick={handleTemplate} disabled={Boolean(busy)}>
            <i className="bi bi-download me-2" aria-hidden="true" />
            {busy === 'template' ? 'Preparing…' : 'Download template'}
          </button>
        </div>

        {busy === 'preview' ? <Spinner label="Checking and pricing the file…" /> : null}
        {busy === 'import' ? <Spinner label="Importing loans…" /> : null}

        {summary ? (
          <div className={`alert ${result ? 'alert-success' : allValid ? 'alert-info' : 'alert-warning'}`}>
            <div className="row g-2 small text-center">
              <div className="col-6 col-md">
                <div className="text-uppercase fw-semibold">Total rows</div>
                <div className="fw-bold fs-5">{summary.totalRows}</div>
              </div>
              <div className="col-6 col-md">
                <div className="text-uppercase fw-semibold">Valid</div>
                <div className="fw-bold fs-5">{summary.validRows}</div>
              </div>
              <div className="col-6 col-md">
                <div className="text-uppercase fw-semibold">Invalid</div>
                <div className="fw-bold fs-5">{summary.invalidRows}</div>
              </div>
              <div className="col-6 col-md">
                <div className="text-uppercase fw-semibold">Duplicates</div>
                <div className="fw-bold fs-5">{summary.duplicateRows}</div>
              </div>
              <div className="col-6 col-md">
                <div className="text-uppercase fw-semibold">Imported</div>
                <div className="fw-bold fs-5">{summary.importedRows}</div>
              </div>
            </div>
            {summary.blankRows > 0 ? <div className="small mt-2">{summary.blankRows} empty row(s) were ignored.</div> : null}
            {!result ? (
              <div className="small mt-2">
                {allValid
                  ? 'Nothing has been saved yet — this is a preview of what the system will store.'
                  : 'A loan import is all or nothing. Fix the rows below and upload the file again; nothing will be imported until every row passes.'}
              </div>
            ) : null}
          </div>
        ) : null}

        {result ? (
          <>
            <h3 className="h6 fw-bold">Imported loans</h3>
            <div className="table-responsive" style={{ maxHeight: '18rem' }}>
              <table className="table table-sm align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th scope="col">Loan number</th>
                    <th scope="col" className="text-end">Amount</th>
                    <th scope="col" className="text-end">Repayment</th>
                    <th scope="col" className="text-end">EMI</th>
                    <th scope="col" className="text-end">Instalments</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.imported.map((loan) => (
                    <tr key={loan.loanNumber}>
                      <td className="font-monospace">{loan.loanNumber}</td>
                      <td className="text-end">{formatCurrency(loan.loanAmount)}</td>
                      <td className="text-end">{formatCurrency(loan.totalRepayment)}</td>
                      <td className="text-end">{formatCurrency(loan.emiAmount)}</td>
                      <td className="text-end">{loan.emiCount}</td>
                      <td>
                        <span className="badge text-bg-success">{loan.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {rows.length > 0 ? (
          <>
            <h3 className="h6 fw-bold">Rows</h3>
            <div className="table-responsive" style={{ maxHeight: '22rem' }}>
              <table className="table table-sm align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th scope="col">Excel row</th>
                    <th scope="col">Applicant</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="text-end">Amount</th>
                    <th scope="col">Tenure</th>
                    <th scope="col" className="text-end">Collections</th>
                    <th scope="col">Calculated by the system</th>
                    <th scope="col">Status</th>
                    <th scope="col">Problems</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, MAX_PREVIEW_ROWS).map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="fw-semibold">{row.rowNumber}</td>
                      <td>
                        {row.applicant ? (
                          <>
                            <span className="font-monospace">{row.applicant.cifId}</span>
                            <span className="d-block text-secondary small">{row.applicant.fullName}</span>
                          </>
                        ) : (
                          <span className="text-secondary">{row.values.applicantCif ?? '—'}</span>
                        )}
                      </td>
                      <td>{row.values.loanType ?? '—'}</td>
                      <td className="text-end">{row.values.loanAmount ? formatCurrency(row.values.loanAmount) : '—'}</td>
                      <td>
                        {row.values.tenure ?? '—'} {(row.values.tenureUnit ?? 'PERIODS') === 'MONTHS' ? 'months' : 'periods'}
                      </td>
                      <td className="text-end">{row.values.collectionCount ?? '—'}</td>
                      <td className="small">
                        {row.financials ? (
                          <>
                            <div>
                              Interest {formatCurrency(row.financials.interest)} · Repayment{' '}
                              {formatCurrency(row.financials.totalRepayment)}
                            </div>
                            <div className="text-secondary">
                              {formatCurrency(row.financials.emiAmount)} × {row.financials.emiCount}
                              {row.financials.endDate ? ` · ends ${row.financials.endDate}` : ''}
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[row.status] ?? 'text-bg-secondary'}`}>
                          {STATUS_LABEL[row.status] ?? row.status}
                        </span>
                      </td>
                      <td className="small">
                        {row.errors.length === 0
                          ? '—'
                          : row.errors.map((problem, index) => (
                              <div key={`${row.rowNumber}-${problem.field}-${index}`}>
                                <span className="fw-semibold">{problem.field}</span>: {problem.reason}
                              </div>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > MAX_PREVIEW_ROWS ? (
              <p className="form-text mb-0">
                Showing the first {MAX_PREVIEW_ROWS} of {rows.length} rows. All of them are checked.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={Boolean(busy)}>
          {result ? 'Close' : 'Cancel'}
        </button>
        {!result ? (
          <button type="button" className="btn btn-primary" onClick={handleImport} disabled={!canImport}>
            {busy === 'import' ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Importing…
              </>
            ) : (
              `Import ${summary?.totalRows ?? 0} loan${(summary?.totalRows ?? 0) === 1 ? '' : 's'}`
            )}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
