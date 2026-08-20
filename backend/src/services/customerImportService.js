'use strict';

const { Op } = require('sequelize');
const { sequelize, Customer } = require('../models');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const customerService = require('./customerService');
const customerValidator = require('../validators/customerValidator');
const { validationResult } = require('express-validator');
const { normalizeMobile } = require('../utils/mobile');
const spreadsheet = require('../utils/spreadsheet');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');
const {
  MAX_ROWS,
  SHEET_NAME,
  COLUMNS,
  HEADER_TO_FIELD,
  BACKEND_OWNED_HEADERS,
  ROW_STATUS,
  TEMPLATE_FILENAME
} = require('../config/customerImport');

/**
 * Bulk customer import.
 *
 * Three rules shape this module:
 *
 *   1. The spreadsheet is untrusted input. Cells are read as data, never
 *      evaluated: a formula cell contributes its cached result, never a
 *      recalculation, and nothing is executed.
 *   2. Rows are validated by the SAME express-validator chains the single
 *      create endpoint uses, so an import can never accept something the form
 *      would reject, and the two can never drift apart.
 *   3. CIFID is allocated by the customer service inside the import's own
 *      transaction, so it stays concurrency-safe and a spreadsheet can never
 *      supply one.
 */

/**
 * Reads the workbook into header-mapped rows, using the shared spreadsheet
 * reader — one parser serves every importer, so the file-safety rules cannot
 * drift apart between them.
 */
async function parseWorkbook(buffer, { filename } = {}) {
  return spreadsheet.parseWorkbook(buffer, {
    columns: COLUMNS,
    sheetName: SHEET_NAME,
    headerToField: HEADER_TO_FIELD,
    backendOwnedHeaders: BACKEND_OWNED_HEADERS,
    maxRows: MAX_ROWS,
    filename
  });
}

/** Runs the real create-customer chains against one row. */
async function validateRow(values) {
  const request = { body: { ...values }, params: {}, query: {}, headers: {} };
  await Promise.all(customerValidator.createCustomerRules.map((rule) => rule.run(request)));

  return validationResult(request)
    .array()
    .map((error) => ({ field: error.path, reason: error.msg }));
}

/**
 * Validates every parsed row and marks duplicates.
 *
 * The customer table has no unique constraint on mobile, and single-customer
 * creation does not refuse one — that stays true. But a bulk file is exactly
 * where an accidental re-import does damage, so an import refuses to create a
 * customer whose mobile already exists, and refuses to create the same mobile
 * twice within one file. Nothing existing is ever updated or overwritten.
 */
async function findExistingByMobile(rows) {
  const mobiles = [...new Set(rows.map((row) => normalizeMobile(row.values.mobile)).filter(Boolean))];

  const existing =
    mobiles.length > 0
      ? await Customer.findAll({ where: { mobile: { [Op.in]: mobiles } }, attributes: ['id', 'cifId', 'mobile', 'fullName'] })
      : [];

  return new Map(existing.map((customer) => [customer.mobile, customer]));
}

async function evaluateRows(rows, existingByMobile = new Map()) {
  const seenInFile = new Map();

  const evaluated = [];

  for (const row of rows) {
    const errors = await validateRow(row.values);
    const mobile = normalizeMobile(row.values.mobile);

    if (errors.length === 0 && mobile) {
      const clash = existingByMobile.get(mobile);
      if (clash) {
        errors.push({ field: 'duplicate', reason: `Customer already exists with this mobile (${clash.cifId})` });
      } else if (seenInFile.has(mobile)) {
        errors.push({ field: 'duplicate', reason: `Duplicate of row ${seenInFile.get(mobile)} in this file` });
      } else {
        seenInFile.set(mobile, row.rowNumber);
      }
    }

    const duplicate = errors.some((error) => error.field === 'duplicate');
    evaluated.push({
      rowNumber: row.rowNumber,
      status: errors.length === 0 ? ROW_STATUS.VALID : duplicate ? ROW_STATUS.DUPLICATE : ROW_STATUS.INVALID,
      values: row.values,
      errors
    });
  }

  return evaluated;
}

function summarise(evaluated, blankRows) {
  const valid = evaluated.filter((row) => row.status === ROW_STATUS.VALID).length;
  const duplicates = evaluated.filter((row) => row.status === ROW_STATUS.DUPLICATE).length;
  const invalid = evaluated.filter((row) => row.status === ROW_STATUS.INVALID).length;

  return { totalRows: evaluated.length, validRows: valid, invalidRows: invalid, duplicateRows: duplicates, blankRows };
}

/** Flat error list for the UI: row number, field, reason. */
function collectErrors(evaluated) {
  return evaluated.flatMap((row) => row.errors.map((error) => ({ row: row.rowNumber, field: error.field, reason: error.reason })));
}

/**
 * Parses and validates, and writes nothing at all.
 * There is no `sequelize.transaction`, no `create` and no `update` in this path.
 */
async function previewImport(buffer, { filename } = {}) {
  const parsed = await parseWorkbook(buffer, { filename });
  const evaluated = await evaluateRows(parsed.rows, await findExistingByMobile(parsed.rows));

  return {
    file: { name: parsed.filename, sheet: parsed.sheetName },
    summary: { ...summarise(evaluated, parsed.blankRows), importedRows: 0, previewOnly: true },
    rows: evaluated,
    errors: collectErrors(evaluated)
  };
}

/**
 * Imports the valid rows of a workbook.
 *
 * The file is parsed and validated again from scratch — nothing from a previous
 * preview is trusted, so a client cannot smuggle in a row the backend rejected.
 * Every insert runs in ONE transaction: if any row fails, the whole import rolls
 * back and no customer is left behind.
 */
async function runImport(buffer, actor, context, { filename } = {}) {
  const parsed = await parseWorkbook(buffer, { filename });
  const evaluated = await evaluateRows(parsed.rows, await findExistingByMobile(parsed.rows));
  const importable = evaluated.filter((row) => row.status === ROW_STATUS.VALID);

  if (importable.length === 0) {
    throw ApiError.badRequest('No valid rows to import. Fix the reported rows and upload the file again.');
  }

  const created = await sequelize.transaction(async (transaction) => {
    /*
     * Sequentially, never in parallel.
     *
     * CIFIDs are allocated by locking the counter row, which serialises
     * SEPARATE transactions. Two allocations inside the SAME transaction are
     * not serialised by that lock — it is already held — so running the rows
     * concurrently would read the same counter twice and mint a duplicate
     * CIFID. Awaiting one row at a time makes the allocation strictly ordered,
     * while the surrounding transaction still keeps the batch all-or-nothing
     * and still blocks any concurrent creation elsewhere.
     */
    const records = [];
    for (const row of importable) {
      // Reuses the customer service's own creation path, so CIFID allocation,
      // field whitelisting and defaults are identical to a single create.
      records.push(await customerService.createCustomerRecord(row.values, actor, transaction));
    }
    return records;
  });

  const summary = { ...summarise(evaluated, parsed.blankRows), importedRows: created.length, previewOnly: false };

  // One audit row for the batch, carrying what was created rather than the file.
  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.CUSTOMERS_IMPORTED,
    entity: AUDIT_ENTITIES.CUSTOMER,
    entityId: null,
    details: {
      file: parsed.filename,
      sheet: parsed.sheetName,
      ...summary,
      cifIds: created.map((customer) => customer.cifId)
    }
  });

  return {
    file: { name: parsed.filename, sheet: parsed.sheetName },
    summary,
    imported: created.map((customer) => ({ cifId: customer.cifId, fullName: customer.fullName, mobile: customer.mobile })),
    rows: evaluated,
    errors: collectErrors(evaluated)
  };
}

/** The downloadable template: one header row, one example row, and notes. */
async function buildTemplate() {
  const buffer = await spreadsheet.buildTemplateWorkbook({
    columns: COLUMNS,
    sheetName: SHEET_NAME,
    textColumns: ['mobile', 'alternateMobile', 'pincode'],
    notes: [
      {
        header: 'CIFID',
        required: 'System',
        note: 'Generated by the system on import. Do not add a CIFID column — a file containing one is refused.'
      },
      { header: 'Row limit', required: '', note: `At most ${MAX_ROWS} data rows per file. Delete the example row before importing.` },
      { header: 'Duplicates', required: '', note: 'A row whose mobile already exists, or repeats earlier in the file, is reported and skipped.' }
    ]
  });

  return { buffer, filename: TEMPLATE_FILENAME };
}

module.exports = {
  parseWorkbook,
  validateRow,
  findExistingByMobile,
  evaluateRows,
  summarise,
  collectErrors,
  previewImport,
  runImport,
  buildTemplate
};
