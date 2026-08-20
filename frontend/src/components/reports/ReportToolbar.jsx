import { useState } from 'react';
import usePermissions from '../../hooks/usePermissions';
import { exportReportCsv, exportReportExcel } from '../../services/reportService';
import { PERMISSIONS } from '../../utils/permissions';

/**
 * Shared header for every report page: title, refresh, reset and export.
 *
 * `exportFormat` decides what the button offers. Every report now exports an
 * .xlsx workbook with a Summary sheet, so that is the default; the CSV path is
 * still served by the backend and reachable by passing 'csv'. Either way the
 * file is built by the backend from the same filtered query the screen ran, so a
 * download cannot diverge from what is on screen.
 *
 * Export is offered only with `reports.export`; the backend refuses the download
 * regardless, so hiding the button is convenience rather than the control.
 */
export default function ReportToolbar({
  title,
  description,
  reportKey,
  filters,
  onRefresh,
  onReset,
  loading,
  resultCount,
  exportFormat = 'xlsx'
}) {
  const { can } = usePermissions();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const canExport = can(PERMISSIONS.REPORTS_EXPORT);

  const handleExport = async () => {
    setExporting(true);
    setExportError('');
    try {
      await (exportFormat === 'xlsx' ? exportReportExcel : exportReportCsv)(reportKey, filters);
    } catch (error) {
      setExportError(error.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 fw-bold mb-1">{title}</h1>
          <p className="text-secondary mb-0">
            {description}
            {typeof resultCount === 'number' ? (
              <span className="ms-2 badge text-bg-light border">{resultCount} rows</span>
            ) : null}
          </p>
        </div>

        <div className="d-flex flex-wrap gap-2">
          <button type="button" className="btn btn-outline-secondary" onClick={onReset} disabled={loading}>
            <i className="bi bi-arrow-counterclockwise me-1" aria-hidden="true" />
            Reset
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={onRefresh} disabled={loading}>
            <i className="bi bi-arrow-clockwise me-1" aria-hidden="true" />
            Refresh
          </button>
          {canExport ? (
            <button type="button" className="btn btn-primary" onClick={handleExport} disabled={exporting || loading}>
              {exporting ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                  Exporting…
                </>
              ) : (
                <>
                  <i
                    className={`bi ${exportFormat === 'xlsx' ? 'bi-file-earmark-excel' : 'bi-filetype-csv'} me-1`}
                    aria-hidden="true"
                  />
                  {exportFormat === 'xlsx' ? 'Export Excel' : 'Export CSV'}
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      {exportError ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <i className="bi bi-exclamation-triangle-fill mt-1" aria-hidden="true" />
          <div className="flex-grow-1">{exportError}</div>
          <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => setExportError('')} />
        </div>
      ) : null}
    </>
  );
}
