import { useRef, useState } from 'react';
import AlertMessage from '../common/AlertMessage';
import Spinner from '../common/Spinner';
import { previewOneBulkImport, runOneBulkImport, downloadOneBulkTemplate } from '../../services/oneBulkService';
import { formatCurrency } from '../../utils/loanConstants';

/*
 * TEMPORARY: oneBulk historical collection migration utility.
 * Can be removed after historical collections are migrated — delete this
 * file, `OneBulkImportPage.jsx`, `services/oneBulkService.js`, and the route
 * plus nav entry that point at the page. Nothing in the normal collection UI
 * (CollectionsListPage, CollectionImportModal, CollectionFormModal) imports
 * from here, and this file imports nothing from them either.
 *
 * Purpose: backfilling collections that were actually received before a loan
 * went live on the LMS, so the historical EMI ledger reads correctly.
 *
 * Nothing here allocates or posts money on its own. The workbook carries who
 * paid, how much, when and how; the backend plans the split across
 * instalments with the SAME FIFO engine the Post Collection screen and the
 * permanent bulk import use, and posts through the SAME posting function —
 * this component only uploads, previews and confirms.
 */

const MAX_PREVIEW_ROWS = 200;

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

export default function OneBulkImport() {
  const inputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleTemplate = async () => {
    setError('');
    setBusy('template');
    try {
      await downloadOneBulkTemplate();
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
      const response = await previewOneBulkImport(chosen);
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
      const response = await runOneBulkImport(file);
      setResult(response.data);
      setPreview(null);
    } catch (requestError) {
      setError(requestError.message || 'The import could not be completed.');
    } finally {
      setBusy('');
    }
  };

  const summary = preview?.summary ?? result?.summary ?? null;
  const rows = preview?.rows ?? result?.rows ?? [];
  const allValid = Boolean(summary) && summary.totalRows > 0 && summary.validRows === summary.totalRows;
  const canImport = Boolean(file) && allValid && !busy && !result;

  return (
    <div className="container-fluid px-0">
      <div className="alert alert-warning d-flex align-items-start gap-3 mb-4" role="alert">
        <i className="bi bi-exclamation-triangle-fill mt-1" aria-hidden="true" />
        <div>
          <div className="fw-semibold">oneBulk — temporary migration utility</div>
          <div className="small">
            For backfilling collections that were actually received before a loan went live on the LMS. This is not
            part of the normal collection workflow and will be removed once historical collections are migrated. Use
            the current loan number for every loan — old, superseded loan numbers are not recognised.
          </div>
        </div>
      </div>

      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">oneBulk historical collection import</h1>
          <p className="text-secondary mb-0">
            Upload, preview the allocation, and confirm. Every payment is planned oldest-instalment-first and, for the
            same loan, oldest-date-first — exactly as posting each one by hand, in order, would.
          </p>
        </div>
        <button type="button" className="btn btn-outline-secondary" onClick={handleTemplate} disabled={Boolean(busy)}>
          <i className="bi bi-download me-2" aria-hidden="true" />
          {busy === 'template' ? 'Preparing…' : 'Download template'}
        </button>
      </div>

      <div className="card mb-4">
        <div className="card-body">
          <AlertMessage message={error} onDismiss={() => setError('')} />

          <div className="d-flex flex-wrap align-items-end gap-3">
            <div className="flex-grow-1">
              <label className="form-label small fw-semibold" htmlFor="one-bulk-file">
                Excel file (.xlsx)
              </label>
              <input
                id="one-bulk-file"
                ref={inputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="form-control"
                onChange={handleFile}
                disabled={Boolean(busy) || Boolean(result)}
              />
              <div className="form-text">
                Loan Number, Payer CIFID, Amount, Collection Date (optional), Payment Mode, Reference, Notes.
                Allocation is decided by the system — a file naming an allocation, EMI or balance column is refused.
                Leave Collection Date blank to have the system date each payment from the instalment(s) it settles;
                a payment spanning instalments due on different dates then becomes one collection per date.
              </div>
            </div>
            {result ? (
              <button type="button" className="btn btn-outline-secondary" onClick={reset}>
                Start another import
              </button>
            ) : null}
          </div>

          {busy === 'preview' ? <Spinner label="Checking the file and planning the allocation…" /> : null}
          {busy === 'import' ? <Spinner label="Posting historical collections…" /> : null}

          {summary ? (
            <div className={`alert mt-3 ${result ? 'alert-success' : allValid ? 'alert-info' : 'alert-warning'}`}>
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
                  <div className="fw-bold fs-5">{formatCurrency(result ? summary.importedAmount : summary.validAmount)}</div>
                </div>
              </div>
              {summary.blankRows > 0 ? <div className="small mt-2">{summary.blankRows} empty row(s) were ignored.</div> : null}
              {!result ? (
                <div className="small mt-2">
                  {allValid
                    ? 'Nothing has been posted yet — this is a preview of where each payment will land.'
                    : 'A oneBulk import is all or nothing. Fix the rows below and upload the file again; nothing will be posted until every row passes.'}
                </div>
              ) : (
                <div className="small mt-2">
                  Reconciliation:{' '}
                  {result.reconciliation?.collectionAmountEqualsAllocationTotal ? 'PASS' : 'FAIL'} — {result.reconciliation?.loansAffected}{' '}
                  loan(s), {result.reconciliation?.emisAffected} instalment(s) affected ({result.reconciliation?.fullyPaidEmis} fully
                  paid, {result.reconciliation?.partiallyPaidEmis} partially paid).
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {result ? (
        <div className="card mb-4">
          <div className="card-body">
            <h2 className="h6 fw-bold">Posted collections</h2>
            <p className="form-text mt-0">
              One Excel row can produce more than one collection when its Collection Date was left blank and the
              amount spanned instalments due on different dates — each row is shown for every collection it produced.
            </p>
            <div className="table-responsive" style={{ maxHeight: '18rem' }}>
              <table className="table table-sm align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th scope="col">Excel row</th>
                    <th scope="col">Collection</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="text-end">Amount</th>
                    <th scope="col">Allocated to</th>
                  </tr>
                </thead>
                <tbody>
                  {result.imported.map((collection) => (
                    <tr key={collection.collectionNumber}>
                      <td className="fw-semibold">{collection.row}</td>
                      <td className="font-monospace">{collection.collectionNumber}</td>
                      <td>
                        {collection.collectionDate}
                        {collection.dateSource === 'AUTO_EMI_DATE' ? (
                          <span className="text-secondary small"> (EMI date, auto)</span>
                        ) : null}
                      </td>
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
          </div>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="card">
          <div className="card-body">
            <h2 className="h6 fw-bold">Rows</h2>
            <div className="table-responsive" style={{ maxHeight: '26rem' }}>
              <table className="table table-sm align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    <th scope="col">Excel row</th>
                    <th scope="col">Loan</th>
                    <th scope="col">Payer</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="text-end">Amount</th>
                    <th scope="col">Mode</th>
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
                      <td>
                        {row.values.collectionDate ? (
                          row.values.collectionDate
                        ) : (
                          <span className="badge text-bg-info-subtle text-info-emphasis" title="Derived from the instalment date(s) this payment settles">
                            AUTO — EMI DATE
                          </span>
                        )}
                      </td>
                      <td className="text-end">{row.values.amount ? formatCurrency(row.values.amount) : '—'}</td>
                      <td>{row.values.ledgerType ?? '—'}</td>
                      <td className="small">
                        {row.dateGroups?.length ? (
                          row.dateGroups.map((group) => (
                            <div key={`${row.rowNumber}-${group.date}`} className="mb-1">
                              <div className="fw-semibold">
                                {group.date}
                                {group.source === 'AUTO_EMI_DATE' ? (
                                  <span className="text-secondary fw-normal"> (EMI date, auto)</span>
                                ) : null}{' '}
                                → {formatCurrency(group.amount)}
                              </div>
                              {group.allocations.map((allocation) => (
                                <div key={`${row.rowNumber}-${group.date}-${allocation.emiId}`} className="text-secondary ps-2">
                                  EMI #{allocation.emiNumber} → {formatCurrency(allocation.amount)}
                                </div>
                              ))}
                            </div>
                          ))
                        ) : row.allocation?.length ? (
                          row.allocation.map((allocation) => (
                            <div key={`${row.rowNumber}-${allocation.emiId}`}>
                              EMI #{allocation.emiNumber} → {formatCurrency(allocation.amount)}
                            </div>
                          ))
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
              <p className="form-text mb-0 mt-2">
                Showing the first {MAX_PREVIEW_ROWS} of {rows.length} rows. All of them are checked.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {!result && rows.length > 0 ? (
        <div className="d-flex justify-content-end mt-4">
          <button type="button" className="btn btn-primary" onClick={handleImport} disabled={!canImport}>
            {busy === 'import' ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Posting…
              </>
            ) : (
              `Post ${summary?.totalRows ?? 0} historical collection${(summary?.totalRows ?? 0) === 1 ? '' : 's'}`
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}
