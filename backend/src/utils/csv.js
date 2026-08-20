'use strict';

/**
 * Minimal RFC 4180 CSV serialiser.
 *
 * Written here rather than pulled in as a dependency — the project has no CSV
 * library and the requirement is a few lines of quoting rules.
 */

/** Reads "customer.cifId" out of a row without throwing on a missing branch. */
function readPath(row, path) {
  return path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), row);
}

/**
 * Quotes a single field.
 *
 * A leading =, +, - or @ is prefixed with a single quote: spreadsheet software
 * treats those as formulas, so an unescaped value could execute on open. This
 * is the CSV-injection guard, not cosmetic.
 */
function escapeField(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/**
 * Builds a CSV document from rows and an explicit column definition.
 * Columns are declared, never inferred from the data, so a field that was not
 * intended for export cannot appear in the file.
 */
function toCsv(rows, columns) {
  const header = columns.map((column) => escapeField(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeField(readPath(row, column.path))).join(','));

  // CRLF line endings and a UTF-8 BOM keep Excel happy with non-ASCII names.
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

/** Safe, timestamped download filename. */
function csvFilename(reportKey, asOf) {
  const stamp = String(asOf ?? new Date().toISOString().slice(0, 10)).replace(/[^0-9a-zA-Z-]/g, '');
  return `lms-${String(reportKey).replace(/[^a-z-]/gi, '')}-${stamp}.csv`;
}

module.exports = { toCsv, escapeField, readPath, csvFilename };
