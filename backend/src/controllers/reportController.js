'use strict';

const reportService = require('../services/reportService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/apiResponse');
const { toCsv, csvFilename } = require('../utils/csv');
const reportExcelService = require('../services/reportExcelService');
const { REPORTS, CSV_COLUMNS, EXPORT_FORMATS, EXPORT_MAX_ROWS, EXPORT_SCOPE } = require('../config/reports');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');

/**
 * Each report has one handler that serves JSON, CSV and Excel.
 *
 * Every export runs the SAME service call with a raised limit — the rows in the
 * file are exactly the rows the filters select, so a download can never diverge
 * from what the screen shows or bypass the caller's scope. The workbook's
 * summary is the report's own summary block, not a second calculation.
 */
function reportHandler({ key, run, rowsOf }) {
  return asyncHandler(async (req, res) => {
    const format = req.query.format;
    const wantsCsv = format === EXPORT_FORMATS.CSV;
    const wantsExcel = format === EXPORT_FORMATS.XLSX;
    const wantsFile = wantsCsv || wantsExcel;

    const data = await run(
      wantsFile ? { ...req.query, page: 1, limit: EXPORT_MAX_ROWS, [EXPORT_SCOPE]: true } : req.query,
      req.user
    );

    if (!wantsFile) {
      return sendSuccess(res, { message: 'Report generated successfully', data });
    }

    const rows = rowsOf(data);

    if (rows.length >= EXPORT_MAX_ROWS) {
      throw ApiError.badRequest(
        `This export would exceed ${EXPORT_MAX_ROWS} rows. Narrow the filters (for example by date range) and try again.`
      );
    }

    // An export leaves the system, so unlike a report view it is audited.
    await auditService.record({
      ...auditService.contextFrom(req),
      action: AUDIT_ACTIONS.REPORT_EXPORTED,
      entity: AUDIT_ENTITIES.REPORT,
      entityId: key,
      details: { report: key, format, rowCount: rows.length, filters: sanitizeFilters(req.query) }
    });

    if (wantsExcel) {
      const workbook = await reportExcelService.buildReportWorkbook({
        reportKey: key,
        rows,
        summary: data.summary ?? {},
        filters: sanitizeFilters(req.query)
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportExcelService.excelFilename(key, req.query.date ?? req.query.dateFrom)}"`
      );
      res.setHeader('Content-Length', workbook.length);
      return res.status(200).send(workbook);
    }

    const csv = toCsv(rows, CSV_COLUMNS[key]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(key, req.query.date ?? req.query.dateFrom)}"`);
    return res.status(200).send(csv);
  });
}

/** Records which filters produced an export, without echoing paging noise. */
function sanitizeFilters(query) {
  const { format, page, limit, ...rest } = query;
  return rest;
}

const loanReport = reportHandler({
  key: REPORTS.LOANS,
  run: reportService.loanReport,
  rowsOf: (data) => data.loans
});

const collectionReport = reportHandler({
  key: REPORTS.COLLECTIONS,
  run: reportService.collectionReport,
  rowsOf: (data) => data.collections
});

const emiReport = reportHandler({
  key: REPORTS.EMIS,
  run: reportService.emiReport,
  rowsOf: (data) => data.emis
});

const demandCollectionReport = reportHandler({
  key: REPORTS.DEMAND_COLLECTIONS,
  run: reportService.demandCollectionReport,
  rowsOf: (data) => data.rows
});

module.exports = { loanReport, collectionReport, emiReport, demandCollectionReport };
