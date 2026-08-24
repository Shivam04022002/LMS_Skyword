'use strict';

const ExcelJS = require('exceljs');
const ApiError = require('./ApiError');

/**
 * Reading an uploaded workbook, once, for every importer.
 *
 * The spreadsheet is untrusted input. Cells are read as data and never
 * evaluated: a formula cell contributes its cached result, never a
 * recalculation, and nothing is executed. Anything structurally wrong — the
 * wrong file, no sheet, an unknown column, too many rows — becomes a 400 with a
 * readable message, so a parser error never reaches the operator.
 *
 * ── PERCENTAGE-FORMATTED CELLS ────────────────────────────────────────────────
 * Excel stores a percentage as the FRACTION and leaves the number format to say
 * so: a cell the operator sees as "5%" holds 0.05 with numFmt "0%". Reading the
 * stored number alone therefore silently divides the operator's figure by 100 —
 * an ROI meant as 5% a month becomes 0.05% a month, and the loan is priced at a
 * hundredth of its rate with nothing to show for it.
 *
 * A cell is read as the value it DISPLAYS, so what the operator saw is what the
 * importer receives. This is a parsing rule and nothing more: no rate is
 * converted, no annual/monthly meaning is applied, and the value handed on is
 * the same one a plainly-typed cell would have produced.
 */

/** Every .xlsx is a ZIP container, so it must start with the ZIP magic bytes. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Loose header matching: "First Name", "firstName" and "first_name" all agree. */
const normalizeHeader = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Whether a number format displays its value multiplied by a hundred.
 *
 * A bare `%` is Excel's percentage token. One that is escaped (`\%`), quoted
 * (`"%"`) or sitting inside a colour or condition block (`[Red]`) is a literal
 * character and means nothing, so those are removed before the test — a format
 * such as `0" %"` prints a per-cent sign without scaling anything.
 */
function isPercentFormat(numFmt) {
  if (typeof numFmt !== 'string') return false;

  return numFmt
    .replace(/\./g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .includes('%');
}

/**
 * The number a percentage-formatted cell shows: 0.05 -> 5, 0.125 -> 12.5.
 *
 * `x * 100` alone leaves floating-point dust (0.125 * 100 is 12.500000000000002),
 * which would then fail a decimal-places rule for a value the operator typed
 * exactly. Fifteen significant digits is the most a double carries reliably, so
 * rounding there clears the dust without inventing precision, at any magnitude.
 */
function percentToDisplayed(value) {
  if (!Number.isFinite(value)) return value;
  return Number((value * 100).toPrecision(15));
}

/** A cell's value as plain data. Formulas contribute their stored result only. */
function cellValue(cell) {
  const raw = cell?.value;

  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    // Excel dates arrive as UTC midnight; the date part is what matters.
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === 'object') {
    // { formula, result } — the cached result is used as-is and never evaluated.
    // The format travels with it: a formula cell can be percentage-formatted too.
    if ('result' in raw) return cellValue({ value: raw.result, numFmt: cell?.numFmt });
    // { richText: [...] } — the visible text.
    if (Array.isArray(raw.richText)) return raw.richText.map((part) => part.text).join('');
    // { text, hyperlink } — the visible text, not the link target.
    if ('text' in raw) return String(raw.text);
    if ('error' in raw) return null;
    return null;
  }

  // Only a NUMBER carrying a percentage format is rescaled. A plainly-formatted
  // number, a string, a boolean and a date all pass through untouched.
  if (typeof raw === 'number' && isPercentFormat(cell?.numFmt)) {
    return percentToDisplayed(raw);
  }

  return raw;
}

/** Trims to a string, or null for a blank. */
function asText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return String(value);
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

/**
 * Reads a workbook into header-mapped rows.
 *
 * `columns` describes what the importer accepts; `backendOwnedHeaders` names the
 * columns the system owns, so a file that tries to supply one gets the real
 * reason rather than a generic "unknown column".
 */
async function parseWorkbook(buffer, { columns, sheetName, headerToField, backendOwnedHeaders = {}, maxRows, filename } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw ApiError.badRequest('No file was uploaded');
  }

  if (!buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    // Every .xlsx is a ZIP container; anything else is not one, whatever it is
    // called or whatever content type it claimed.
    throw ApiError.badRequest('That file is not a valid .xlsx workbook');
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    // The underlying parser error is never surfaced.
    throw ApiError.badRequest('That workbook could not be read. Save it as .xlsx and try again.');
  }

  const sheet = workbook.getWorksheet(sheetName) ?? workbook.worksheets[0];
  if (!sheet) {
    throw ApiError.badRequest('The workbook has no worksheet');
  }

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber] = asText(cellValue(cell));
  });

  const mapped = [];
  const unknown = [];
  const owned = [];

  headers.forEach((header, columnNumber) => {
    if (!header) return;
    const key = normalizeHeader(header);
    if (backendOwnedHeaders[key]) {
      owned.push({ header, reason: backendOwnedHeaders[key] });
      return;
    }
    const field = headerToField[key];
    if (!field) {
      unknown.push(header);
      return;
    }
    mapped[columnNumber] = field;
  });

  if (owned.length > 0) {
    throw ApiError.badRequest(
      `The file contains column(s) the system owns: ${owned.map((entry) => `"${entry.header}" — ${entry.reason}`).join('; ')}`
    );
  }

  if (unknown.length > 0) {
    throw ApiError.badRequest(
      `Unrecognised column(s): ${unknown.map((header) => `"${header}"`).join(', ')}. ` +
        `Use the template — supported columns are: ${columns.map((column) => column.header).join(', ')}.`
    );
  }

  const present = mapped.filter(Boolean);
  if (present.length === 0) {
    throw ApiError.badRequest('The first row must be the column headers from the template');
  }

  const rows = [];
  let blankRows = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = {};
    let hasValue = false;

    mapped.forEach((field, columnNumber) => {
      if (!field) return;
      const value = asText(cellValue(row.getCell(columnNumber)));
      if (value !== null) {
        values[field] = value;
        hasValue = true;
      }
    });

    // A wholly empty row is skipped, not reported as an error: spreadsheets
    // collect them at the bottom and they mean nothing.
    if (!hasValue) {
      blankRows += 1;
      continue;
    }

    if (rows.length >= maxRows) {
      throw ApiError.badRequest(`This file has more than ${maxRows} data rows. Split it into smaller files.`);
    }

    rows.push({ rowNumber, values });
  }

  if (rows.length === 0) {
    throw ApiError.badRequest('The file has no data rows');
  }

  return { rows, blankRows, filename: filename ?? null, sheetName: sheet.name, columns: present };
}

/**
 * Builds a template workbook: a header row with required columns starred, one
 * example row, and a Notes sheet explaining every column.
 */
async function buildTemplateWorkbook({ columns, sheetName, textColumns = [], notes = [] }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LMS';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map((column) => ({
    header: column.required ? `${column.header} *` : column.header,
    key: column.field,
    width: column.width
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: 'middle' };

  sheet.addRow(
    columns.reduce((accumulator, column) => {
      accumulator[column.field] = column.example;
      return accumulator;
    }, {})
  );

  // Text format where a leading zero or a long number would otherwise be lost.
  textColumns.forEach((field) => {
    const index = columns.findIndex((column) => column.field === field) + 1;
    if (index > 0) sheet.getColumn(index).numFmt = '@';
  });

  const notesSheet = workbook.addWorksheet('Notes');
  notesSheet.columns = [
    { header: 'Column', key: 'header', width: 26 },
    { header: 'Required', key: 'required', width: 12 },
    { header: 'Rules', key: 'note', width: 90 }
  ];
  notesSheet.getRow(1).font = { bold: true };
  columns.forEach((column) => {
    notesSheet.addRow({ header: column.header, required: column.required ? 'Required' : 'Optional', note: column.note });
  });
  notesSheet.addRow({});
  notes.forEach((note) => notesSheet.addRow(note));

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  ZIP_MAGIC,
  normalizeHeader,
  isPercentFormat,
  percentToDisplayed,
  cellValue,
  asText,
  parseWorkbook,
  buildTemplateWorkbook
};
