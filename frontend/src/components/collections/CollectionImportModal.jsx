import { useEffect, useRef, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import Spinner from '../common/Spinner';
import {
  previewCollectionImport,
  runCollectionImport,
  downloadCollectionImportTemplate
} from '../../services/collectionService';
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
  DUPLICATE: 'Already posted'
};

/**
 * Bulk collection import: upload, preview the allocation, confirm, summary.
 *
 * Nothing here allocates. The workbook carries who paid, how much, when and
 * how; the backend plans the split across instalments with the same engine the
 * Post Collection screen uses and returns it for display. Confirming re-sends
 * the file to the import endpoint, which re-validates and re-plans against the
 * live ledger — the preview is information, never an instruction.
 *
 * A collection import is all or nothing, so the confirm button stays disabled
 * until every row passes.
 */
export default function CollectionImportModal({ open, onClose, onImported }) {
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
      await downloadCollectionImportTemplate();
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
      const response = await previewCollectionImport(chosen);
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
      const response = await runCollectionImport(file);
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
    <Modal title="Bulk import collections" open={open} onClose={busy ? () => {} : onClose} size="modal-xl">
      <div className="modal-body">
        <AlertMessage message={error} onDismiss={() => setError('')} />

        <div className="d-flex flex-wrap align-items-end justify-content-between gap-3 mb-3">
          <div className="flex-grow-1">
            <label className="form-label small fw-semibold" htmlFor="collection-import-file">
              Excel file (.xlsx)
            </label>
            <input
              id="collection-import-file"
              ref={inputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="form-control"
              onChange={handleFile}
              disabled={Boolean(busy)}
            />
            <div className="form-text">
              Payments only. The system allocates each one across the outstanding instalments, oldest first — a file
              containing an allocation, EMI or balance column is refused.
            </div>
          </div>
          <button type="button" className="btn btn-outline-secondary" onClick={handleTemplate} disabled={Boolean(busy)}>
            <i className="bi bi-download me-2" aria-hidden="true" />
            {busy === 'template' ? 'Preparing…' : 'Download template'}
          </button>
        </div>

        {busy === 'preview' ? <Spinner label="Checking the file and planning the allocation…" /> : null}
        {busy === 'import' ? <Spinner label="Posting collections…" /> : null}

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
                <div className="text-uppercase fw-semibold">Already posted</div>
                <div className="fw-bold fs-5">{summary.duplicateRows}</div>
              </div>
              <div className="col-6 col-md">
                <div className="text-uppercase fw-semibold">{result ? 'Posted' : 'To post'}</div>
                <div className="fw-bold fs-5">
                  {formatCurrency(result ? summary.importedAmount : summary.validAmount)}
                </div>
              </div>
            </div>
            {summary.blankRows > 0 ? <div className="small mt-2">{summary.blankRows} empty row(s) were ignored.</div> : null}
            {!result ? (
              <div className="small mt-2">
                {allValid
                  ? 'Nothing has been posted yet — this is a preview of where each payment will land.'
                  : 'A collection import is all or nothing. Fix the rows below and upload the file again; nothing will be posted until every row passes.'}
              </div>
            ) : null}
          </div>
        ) : null}

        {result ? (
          <>
            <h3 className="h6 fw-bold">Posted collections</h3>
            <div className="table-responsive" style={{ maxHeight: '18rem' }}>
              <table className="table table-sm align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th scope="col">Collection</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="text-end">Amount</th>
                    <th scope="col">Allocated to</th>
                  </tr>
                </thead>
                <tbody>
                  {result.imported.map((collection) => (
                    <tr key={collection.collectionNumber}>
                      <td className="font-monospace">{collection.collectionNumber}</td>
                      <td>{collection.collectionDate}</td>
                      <td className="text-end fw-semibold">{formatCurrency(collection.amount)}</td>
                      <td className="small">
                        {collection.allocations
                          .map((allocation) => `EMI #${allocation.emiNumber} → ${formatCurrency(allocation.amount)}`)
                          .join(', ')}
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
                    <th scope="col">Loan</th>
                    <th scope="col">Payer</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="text-end">Amount</th>
                    <th scope="col">Allocation (by the system)</th>
                    <th scope="col">Status</th>
                    <th scope="col">Problems</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, MAX_PREVIEW_ROWS).map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="fw-semibold">{row.rowNumber}</td>
                      <td className="font-monospace">{row.loan?.loanNumber ?? row.values.loanNumber ?? '—'}</td>
                      <td>
                        {row.payer ? (
                          <>
                            <span className="font-monospace">{row.payer.cifId}</span>
                            <span className="d-block text-secondary small">{row.payer.fullName}</span>
                          </>
                        ) : (
                          <span className="text-secondary">{row.values.payerCif ?? '—'}</span>
                        )}
                      </td>
                      <td>{row.values.collectionDate ?? '—'}</td>
                      <td className="text-end">{row.values.amount ? formatCurrency(row.values.amount) : '—'}</td>
                      <td className="small">
                        {row.allocation?.length
                          ? row.allocation.map((allocation) => (
                              <div key={`${row.rowNumber}-${allocation.emiId}`}>
                                EMI #{allocation.emiNumber} → {formatCurrency(allocation.amount)}
                              </div>
                            ))
                          : '—'}
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
                Posting…
              </>
            ) : (
              `Post ${summary?.totalRows ?? 0} collection${(summary?.totalRows ?? 0) === 1 ? '' : 's'}`
            )}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
