'use strict';

const ExcelJS = require('exceljs');
const { REPORTS, CSV_COLUMNS, SUMMARY_FIELDS, REPORT_TITLES } = require('../config/reports');

/**
 * Renders a report as a real .xlsx workbook.
 *
 * Presentation only: every value comes from the report service's own response —
 * the same rows and the same summary the screen shows — and nothing here
 * recomputes a total. Money is written as a NUMBER with a currency format
 * rather than as text, which is the point of a workbook over a CSV: the reader
 * can sum a column. The authoritative value remains the decimal string the API
 * returned; the cell is a rendering of it.
 *
 * Identifiers — loan numbers, CIFIDs, route codes, mobiles — are written as
 * text so Excel cannot reinterpret them as numbers or dates and quietly drop a
 * leading zero.
 */

const MONEY_FORMAT = '₹#,##0.00';
const NUMBER_FORMAT = '#,##0.####';
const DATE_FORMAT = 'yyyy-mm-dd';
const TEXT_FORMAT = '@';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10233F' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

const MIN_WIDTH = 10;
const MAX_WIDTH = 46;

/** Reads "customer.fullName" out of a row. */
function valueAt(row, path) {
  return String(path)
    .split('.')
    .reduce((current, key) => (current === null || current === undefined ? current : current[key]), row);
}

/** True when a decimal string can be shown as a number without inventing one. */
const isDecimalString = (value) => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);

/**
 * The cell value and its number format for one column.
 * A blank stays blank rather than becoming a zero.
 */
function cellFor(value, type) {
  if (value === null || value === undefined || value === '') {
    return { value: null, numFmt: type === 'money' ? MONEY_FORMAT : undefined };
  }

  switch (type) {
    case 'money':
      return isDecimalString(value) || typeof value === 'number'
        ? { value: Number(value), numFmt: MONEY_FORMAT }
        : { value: String(value) };
    case 'number':
      return isDecimalString(value) || typeof value === 'number'
        ? { value: Number(value), numFmt: NUMBER_FORMAT }
        : { value: String(value) };
    case 'date': {
      // Dates arrive as YYYY-MM-DD (or an ISO timestamp); only the day matters.
      const text = String(value).slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(text)
        ? { value: new Date(`${text}T00:00:00Z`), numFmt: DATE_FORMAT }
        : { value: String(value) };
    }
    case 'code':
      return { value: String(value), numFmt: TEXT_FORMAT };
    default:
      return { value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value) };
  }
}

/** Widens each column to its content, within sensible bounds. */
function autoSize(sheet, columns, rows) {
  columns.forEach((column, index) => {
    const longest = rows.reduce((widest, row) => {
      const raw = valueAt(row, column.path);
      const text = raw === null || raw === undefined ? '' : String(raw);
      return Math.max(widest, text.length);
    }, column.header.length);

    sheet.getColumn(index + 1).width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest + 2));
  });
}

/** Filters the operator actually applied, in a readable form. */
function describeFilters(filters = {}) {
  const skip = new Set(['format', 'page', 'limit']);
  const entries = Object.entries(filters).filter(
    ([key, value]) => !skip.has(key) && value !== undefined && value !== null && String(value).trim() !== ''
  );

  return entries.length > 0 ? entries.map(([key, value]) => ({ key, value: String(value) })) : [];
}

/**
 * Builds the workbook: one sheet of rows, one sheet of totals and filters.
 */
async function buildReportWorkbook({ reportKey, rows = [], summary = {}, filters = {}, generatedAt = new Date() }) {
  const columns = CSV_COLUMNS[reportKey] ?? [];
  const title = REPORT_TITLES[reportKey] ?? 'Report';

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LMS';
  workbook.created = generatedAt;

  // ---- data sheet ----
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  sheet.addRow(columns.map((column) => column.header));

  rows.forEach((row) => {
    const added = sheet.addRow(columns.map((column) => cellFor(valueAt(row, column.path), column.type).value));
    columns.forEach((column, index) => {
      const { numFmt } = cellFor(valueAt(row, column.path), column.type);
      if (numFmt) added.getCell(index + 1).numFmt = numFmt;
    });
  });

  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  // The header stays visible while scrolling, and every column gets a filter.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (columns.length > 0 && rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  autoSize(sheet, columns, rows);

  // ---- summary sheet ----
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { key: 'label', width: 26 },
    { key: 'value', width: 26 }
  ];

  const titleRow = summarySheet.addRow([title, '']);
  titleRow.font = { bold: true, size: 14 };
  summarySheet.addRow(['Generated', generatedAt.toISOString().slice(0, 19).replace('T', ' ') + ' UTC']);
  summarySheet.addRow(['Rows exported', rows.length]);
  summarySheet.addRow([]);

  const totalsHeading = summarySheet.addRow(['Totals', '']);
  totalsHeading.font = { bold: true };
  totalsHeading.fill = HEADER_FILL;
  totalsHeading.font = HEADER_FONT;

  (SUMMARY_FIELDS[reportKey] ?? []).forEach((field) => {
    const { value, numFmt } = cellFor(valueAt(summary, field.path), field.type);
    const row = summarySheet.addRow([field.label, value]);
    if (numFmt) row.getCell(2).numFmt = numFmt;
  });

  summarySheet.addRow([]);
  const filterHeading = summarySheet.addRow(['Active filters', '']);
  filterHeading.fill = HEADER_FILL;
  filterHeading.font = HEADER_FONT;

  const applied = describeFilters(filters);
  if (applied.length === 0) {
    summarySheet.addRow(['None', 'The whole report was exported']);
  } else {
    applied.forEach((filter) => summarySheet.addRow([filter.key, filter.value]));
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** lms-loans-2026-08-19.xlsx */
function excelFilename(reportKey, date) {
  const stamp = date ? String(date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `lms-${reportKey}-${stamp}.xlsx`;
}

module.exports = { REPORTS, buildReportWorkbook, excelFilename, cellFor, valueAt, describeFilters };
