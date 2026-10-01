import { useState } from 'react';
import usePermissions from '../../hooks/usePermissions';
import { exportReportExcel } from '../../services/reportService';
import { PERMISSIONS } from '../../utils/permissions';
import { REPORTS } from '../../utils/reportConstants';

/*
 * The Graph & Analytics page header: title, subtitle, a summary of what is
 * actually on screen, and the four actions.
 *
 * This is the analytics page's own header rather than the shared ReportToolbar
 * because it carries things no report page has — an Apply button, a dirty-state
 * notice, and a filter summary built from the backend's echoed filters. The
 * shared toolbar is used unchanged by five report pages and is deliberately left
 * alone.
 *
 * The export is the SAME call the shared toolbar makes, with the same permission
 * gate and the same applied filters, so nothing about downloading changed: same
 * endpoint, same workbook, same audit entry, same row ceiling.
 */

export default function AnalyticsHeader({
  chips,
  dirty,
  loading,
  appliedFilters,
  pointCount,
  onApply,
  onReset,
  onRefresh
}) {
  const { can } = usePermissions();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const canExport = can(PERMISSIONS.REPORTS_EXPORT);

  const handleExport = async () => {
    setExporting(true);
    setExportError('');
    try {
      // The APPLIED filters, so the file is the charts on screen.
      await exportReportExcel(REPORTS.ANALYTICS, appliedFilters);
    } catch (error) {
      setExportError(error.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-3">
        <div className="min-w-0">
          <h1 className="lms-analytics-title">Graph &amp; Analytics</h1>
          <p className="lms-analytics-subtitle">
            An overview of loan, demand, collection and instalment performance. Every figure is the one the matching
            report produces for the same filters.
          </p>
        </div>

        <div className="d-flex flex-wrap gap-2">
          <button type="button" className="btn btn-outline-secondary lms-analytics-action" onClick={onReset} disabled={loading}>
            <i className="bi bi-arrow-counterclockwise" aria-hidden="true" />
            Reset
          </button>
          <button type="button" className="btn btn-outline-secondary lms-analytics-action" onClick={onRefresh} disabled={loading}>
            <i className="bi bi-arrow-clockwise" aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary lms-analytics-action"
            onClick={onApply}
            disabled={loading || !dirty}
            // Spelled out, because a disabled button that says only "Apply"
            // leaves the reader guessing why.
            title={dirty ? 'Apply the filters below' : 'The filters below are already applied'}
          >
            <i className="bi bi-funnel" aria-hidden="true" />
            Apply
          </button>
          {canExport ? (
            <button
              type="button"
              className="btn btn-success lms-analytics-action"
              onClick={handleExport}
              disabled={exporting || loading}
            >
              {exporting ? (
                <>
                  <span className="spinner-border spinner-border-sm" aria-hidden="true" />
                  Exporting…
                </>
              ) : (
                <>
                  <i className="bi bi-file-earmark-excel" aria-hidden="true" />
                  Export Excel
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      {/*
        What is on screen, stated rather than implied. Built from the dates and
        filters the BACKEND echoed back, so it describes the loaded data and not
        whatever the controls currently hold.
      */}
      {chips.length > 0 ? (
        <div className="lms-analytics-chips mb-3" aria-label="Applied filters">
          <span className="small text-secondary me-1">Showing</span>
          {chips.map((chip) => (
            <span className="lms-analytics-chip" key={chip.key} title={`${chip.label || 'Showing'}: ${chip.value}`}>
              {chip.icon ? (
                <span className="lms-analytics-chip-icon" aria-hidden="true">
                  <i className={`bi ${chip.icon}`} />
                </span>
              ) : null}
              {chip.label ? <span className="lms-analytics-chip-key">{chip.label}</span> : null}
              <span className="lms-analytics-chip-value">{chip.value}</span>
            </span>
          ))}
          {typeof pointCount === 'number' ? (
            <span className="lms-analytics-chip" title="Chart points behind this view, and the rows an export writes">
              <span className="lms-analytics-chip-icon" aria-hidden="true">
                <i className="bi bi-graph-up" />
              </span>
              <span className="lms-analytics-chip-value">{pointCount}</span>
              <span className="lms-analytics-chip-key">points</span>
            </span>
          ) : null}
        </div>
      ) : null}

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
