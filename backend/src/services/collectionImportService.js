'use strict';

const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const { sequelize, Loan, Customer, LoanParty, Collection } = require('../models');
const ApiError = require('../utils/ApiError');
const spreadsheet = require('../utils/spreadsheet');
const auditService = require('./auditService');
const collectionService = require('./collectionService');
const allocationService = require('./collectionAllocationService');
const collectionValidator = require('../validators/collectionValidator');
const { toPaise, fromPaise } = require('../utils/money');
const { today } = require('../utils/dates');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');
const { isValidCifId } = require('../config/customers');
const { LOAN_STATUS } = require('../config/loans');
const { COLLECTION_STATUS } = require('../config/collections');
const { PARTY_STATUS } = require('../config/loanParties');
const {
  MAX_ROWS,
  SHEET_NAME,
  TEMPLATE_FILENAME,
  COLUMNS,
  HEADER_TO_FIELD,
  BACKEND_OWNED_HEADERS,
  ROW_STATUS
} = require('../config/collectionImport');

/**
 * Bulk collection import.
 *
 * The spreadsheet says who paid, how much, when and how. Where the money lands
 * is decided by the existing allocation engine — `planFifoAllocation` derives
 * the oldest-instalment-first split, and `createCollectionRecord` posts it
 * through exactly the path the Post Collection screen uses, with the same
 * eligibility rules, the same allocation validation and the same snapshot
 * rebuild. There is no second allocation engine here, and a workbook column
 * that names an allocation or a derived balance is refused outright.
 *
 * A collection import is ALL OR NOTHING. Money is involved: half a batch is a
 * worse outcome than none, so a single unusable row refuses the file.
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

/** Runs the real post-collection chains against one row's payload. */
async function validateFields(payload) {
  const request = { body: { ...payload }, params: {}, query: {}, headers: {} };
  await Promise.all(collectionValidator.createCollectionRules.map((rule) => rule.run(request)));

  return validationResult(request)
    .array()
    // The allocation list is derived by the backend, so the rule that demands
    // one from a client does not apply to an imported row.
    .filter((error) => !String(error.path).startsWith('allocations'))
    .map((error) => ({ field: error.path, reason: error.msg }));
}

/**
 * Resolves the loan and the payer named by a row, applying the existing
 * eligibility rules rather than restating them.
 */
async function resolveRow(values) {
  const errors = [];
  const loanNumber = values.loanNumber ? String(values.loanNumber).trim().toUpperCase() : null;
  const payerCif = values.payerCif ? String(values.payerCif).trim().toUpperCase() : null;

  let loan = null;
  let payer = null;

  if (!loanNumber) {
    errors.push({ field: 'loanNumber', reason: 'A loan number is required' });
  } else {
    loan = await Loan.findOne({ where: { loanNumber } });
    if (!loan) {
      errors.push({ field: 'loanNumber', reason: `Loan ${loanNumber} not found` });
    } else if (loan.status !== LOAN_STATUS.ACTIVE) {
      errors.push({
        field: 'loanNumber',
        reason:
          loan.status === LOAN_STATUS.CLOSED
            ? `Loan ${loanNumber} is closed. A post-closure adjustment needs a controlled correction workflow.`
            : `Collections cannot be posted against a ${loan.status} loan.`
      });
    }
  }

  if (!payerCif) {
    errors.push({ field: 'payerCif', reason: 'A payer CIFID is required' });
  } else if (!isValidCifId(payerCif)) {
    errors.push({ field: 'payerCif', reason: `"${payerCif}" is not a CIFID (expected C000001)` });
  } else {
    payer = await Customer.findOne({ where: { cifId: payerCif } });
    if (!payer) {
      errors.push({ field: 'payerCif', reason: `Customer ${payerCif} not found` });
    } else if (loan && loan.status === LOAN_STATUS.ACTIVE) {
      // The payer must be a current party to THIS loan — the same rule posting
      // applies, so an unrelated customer can never pay someone else's loan.
      const party = await LoanParty.findOne({
        where: { loanId: loan.id, customerId: payer.id, status: PARTY_STATUS.ACTIVE }
      });
      if (!party) {
        errors.push({ field: 'payerCif', reason: `Customer ${payerCif} is not a party to loan ${loanNumber}` });
      }
    }
  }

  return { errors, loan, payer };
}

/** The collection payload a row describes, in the shape the endpoint accepts. */
function toCollectionPayload(values, { loan, payer }) {
  const payload = {
    loanId: loan?.id,
    customerId: payer?.id,
    amount: values.amount,
    collectionDate: values.collectionDate,
    ledgerType: values.ledgerType ? String(values.ledgerType).trim().toUpperCase() : undefined
  };

  if (values.paymentReference) payload.paymentReference = String(values.paymentReference).trim();
  if (values.notes) payload.notes = String(values.notes).trim();

  return payload;
}

/** What makes two rows the same payment, for duplicate detection. */
const rowSignature = (payload) =>
  [payload.loanId, payload.collectionDate, payload.amount, (payload.paymentReference ?? '').toUpperCase()].join('|');

/**
 * Validates and prices every row.
 *
 * `asOf` is the business date the collection-date rule is measured against, and
 * the date the EMI snapshots would be recomputed on — the same value the manual
 * endpoint uses.
 *
 * Nothing here writes. The allocation for each row comes from the existing
 * planner, with an overlay carrying what the rows above it already consumed, so
 * a workbook posting twice against one loan previews truthfully.
 */
async function evaluateRows(rows, { asOf = today() } = {}) {
  const evaluated = [];
  const seen = new Map();
  // emiId -> paise already taken by earlier rows in this same file.
  const consumed = new Map();

  for (const row of rows) {
    const errors = [];
    const { errors: resolveErrors, loan, payer } = await resolveRow(row.values);
    errors.push(...resolveErrors);

    const payload = toCollectionPayload(row.values, { loan, payer });

    const fieldErrors = await validateFields(payload);
    const loanUnresolved = resolveErrors.some((error) => error.field === 'loanNumber');
    const payerUnresolved = resolveErrors.some((error) => error.field === 'payerCif');
    errors.push(
      ...fieldErrors.filter(
        (error) => !(loanUnresolved && error.field === 'loanId') && !(payerUnresolved && error.field === 'customerId')
      )
    );

    /*
     * Two posting rules live in the collection service rather than the
     * validator chain — a BANK collection needs a traceable reference, and an
     * advance collection is refused. They are called here, not restated, so the
     * operator sees them in the preview instead of at import time.
     */
    if (errors.length === 0) {
      try {
        collectionService.assertPaymentReference(payload.ledgerType, payload.paymentReference ?? null);
      } catch (error) {
        errors.push({ field: 'paymentReference', reason: error.message });
      }

      try {
        collectionService.assertCollectionDate(payload.collectionDate, asOf);
      } catch (error) {
        errors.push({ field: 'collectionDate', reason: error.message });
      }
    }

    let allocation = null;
    if (errors.length === 0) {
      const { plan, unallocated } = await allocationService.planFifoAllocation({
        loanId: payload.loanId,
        amount: payload.amount,
        extraCollected: consumed
      });

      if (toPaise(unallocated) > 0n) {
        // The posting rule accounts for every rupee, so an amount larger than
        // what the loan still owes is refused rather than left unallocated.
        errors.push({
          field: 'amount',
          reason:
            plan.length === 0
              ? 'This loan has nothing outstanding to collect against'
              : `${unallocated} of this payment cannot be allocated — the loan only has ${fromPaise(
                  toPaise(payload.amount) - toPaise(unallocated)
                )} outstanding`
        });
      } else {
        allocation = plan;
        plan.forEach((entry) => {
          consumed.set(entry.emiId, (consumed.get(entry.emiId) ?? 0n) + toPaise(entry.amount));
        });
      }
    }

    // The same payment written twice in one file, or a payment that matches one
    // already posted. Collections carry no uniqueness rule in the database — a
    // customer may genuinely pay the same amount twice in a day — so this is an
    // import-only guard, and two real payments are told apart by their
    // reference.
    let duplicate = false;
    if (errors.length === 0) {
      const signature = rowSignature(payload);
      if (seen.has(signature)) {
        duplicate = true;
        errors.push({ field: 'duplicate', reason: `Identical to row ${seen.get(signature)} in this file` });
      } else {
        seen.set(signature, row.rowNumber);

        const existing = await Collection.findOne({
          where: {
            loanId: payload.loanId,
            collectionDate: payload.collectionDate,
            amount: payload.amount,
            status: COLLECTION_STATUS.POSTED,
            ...(payload.paymentReference ? { paymentReference: payload.paymentReference } : { paymentReference: { [Op.is]: null } })
          }
        });

        if (existing) {
          duplicate = true;
          errors.push({
            field: 'duplicate',
            reason: `Already posted as ${existing.collectionNumber} (same loan, date, amount and reference)`
          });
        }
      }
    }

    evaluated.push({
      rowNumber: row.rowNumber,
      status: errors.length === 0 ? ROW_STATUS.VALID : duplicate ? ROW_STATUS.DUPLICATE : ROW_STATUS.INVALID,
      values: row.values,
      loan: loan ? { loanNumber: loan.loanNumber, status: loan.status } : null,
      payer: payer ? { cifId: payer.cifId, fullName: payer.fullName } : null,
      payload,
      // The split the existing engine would produce — shown so the operator can
      // see where the money lands before agreeing to it.
      allocation,
      errors
    });
  }

  return evaluated;
}

function summarise(evaluated, blankRows) {
  const totalPaise = evaluated
    .filter((row) => row.status === ROW_STATUS.VALID)
    .reduce((total, row) => total + toPaise(row.payload.amount ?? '0'), 0n);

  return {
    totalRows: evaluated.length,
    validRows: evaluated.filter((row) => row.status === ROW_STATUS.VALID).length,
    invalidRows: evaluated.filter((row) => row.status === ROW_STATUS.INVALID).length,
    duplicateRows: evaluated.filter((row) => row.status === ROW_STATUS.DUPLICATE).length,
    blankRows,
    validAmount: fromPaise(totalPaise)
  };
}

const collectErrors = (evaluated) =>
  evaluated.flatMap((row) => row.errors.map((error) => ({ row: row.rowNumber, field: error.field, reason: error.reason })));

/**
 * Parses, validates and plans — and writes nothing at all.
 * There is no transaction, no create and no snapshot rebuild in this path.
 */
async function previewImport(buffer, { filename, asOf = today() } = {}) {
  const parsed = await parseWorkbook(buffer, { filename });
  const evaluated = await evaluateRows(parsed.rows, { asOf });

  return {
    file: { name: parsed.filename, sheet: parsed.sheetName },
    summary: { ...summarise(evaluated, parsed.blankRows), importedRows: 0, importedAmount: '0.00', previewOnly: true },
    rows: evaluated,
    errors: collectErrors(evaluated)
  };
}

/**
 * Posts a whole workbook, or none of it.
 *
 * The file is parsed and validated again from scratch — nothing from a previous
 * preview is trusted, and the allocation is re-planned inside the transaction
 * against the real ledger, so what is written reflects the balances at that
 * moment rather than at preview time. Every collection, its allocations and the
 * EMI snapshots it moves are written in ONE transaction, row by row: collection
 * numbers come from a locked counter, and each row must see the effect of the
 * one before it.
 */
async function runImport(buffer, actor, context, { filename, asOf = today() } = {}) {
  const parsed = await parseWorkbook(buffer, { filename });
  const evaluated = await evaluateRows(parsed.rows, { asOf });
  const summary = summarise(evaluated, parsed.blankRows);

  if (summary.validRows !== summary.totalRows) {
    throw ApiError.badRequest(
      `This file has ${summary.totalRows - summary.validRows} unusable row(s) of ${summary.totalRows}. ` +
        'A collection import is all or nothing — fix the reported rows and upload the file again. Nothing was posted.'
    );
  }

  const created = await sequelize.transaction(async (transaction) => {
    const collections = [];

    for (const row of evaluated) {
      // Re-planned inside the transaction: the rows above have already moved
      // the ledger, and the planner reads it.
      const { plan, unallocated } = await allocationService.planFifoAllocation({
        loanId: row.payload.loanId,
        amount: row.payload.amount,
        transaction
      });

      if (toPaise(unallocated) > 0n) {
        throw ApiError.conflict(
          `Row ${row.rowNumber}: ${unallocated} of this payment cannot be allocated. Nothing was posted.`
        );
      }

      const collection = await collectionService.createCollectionRecord(
        { ...row.payload, allocations: plan.map((entry) => ({ emiId: entry.emiId, amount: entry.amount })) },
        actor,
        transaction,
        { asOf }
      );

      collections.push({ collection, plan, rowNumber: row.rowNumber });
    }

    return collections;
  });

  const importedPaise = created.reduce((total, entry) => total + toPaise(entry.collection.amount), 0n);

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.COLLECTIONS_IMPORTED,
    entity: AUDIT_ENTITIES.COLLECTION,
    entityId: null,
    details: {
      file: parsed.filename,
      sheet: parsed.sheetName,
      ...summary,
      importedRows: created.length,
      importedAmount: fromPaise(importedPaise),
      collectionNumbers: created.map((entry) => entry.collection.collectionNumber)
    }
  });

  return {
    file: { name: parsed.filename, sheet: parsed.sheetName },
    summary: {
      ...summary,
      importedRows: created.length,
      importedAmount: fromPaise(importedPaise),
      previewOnly: false
    },
    imported: created.map((entry) => ({
      row: entry.rowNumber,
      collectionNumber: entry.collection.collectionNumber,
      amount: entry.collection.amount,
      collectionDate: entry.collection.collectionDate,
      allocations: entry.plan.map((allocation) => ({ emiNumber: allocation.emiNumber, amount: allocation.amount }))
    })),
    rows: evaluated,
    errors: collectErrors(evaluated)
  };
}

/** The downloadable template, built from the same column definitions. */
async function buildTemplate() {
  const buffer = await spreadsheet.buildTemplateWorkbook({
    columns: COLUMNS,
    sheetName: SHEET_NAME,
    textColumns: ['loanNumber', 'payerCif', 'collectionDate', 'paymentReference'],
    notes: [
      {
        header: 'Allocation',
        required: 'System',
        note:
          'The system allocates each payment across the outstanding instalments, oldest first, exactly as posting it ' +
          'by hand would. Do not add allocation, EMI, outstanding or status columns — a file containing one is refused.'
      },
      {
        header: 'Amount',
        required: '',
        note: 'A payment cannot exceed what the loan still owes: the whole amount must be allocatable.'
      },
      {
        header: 'Duplicates',
        required: '',
        note:
          'A row matching a posted collection on loan, date, amount and reference is treated as already posted. Give ' +
          'two genuine payments of the same amount on the same day different references.'
      },
      { header: 'Row limit', required: '', note: `At most ${MAX_ROWS} data rows per file. Delete the example row before importing.` },
      {
        header: 'All or nothing',
        required: '',
        note: 'If any row is unusable the whole file is refused and nothing is posted.'
      }
    ]
  });

  return { buffer, filename: TEMPLATE_FILENAME };
}

module.exports = {
  parseWorkbook,
  validateFields,
  resolveRow,
  toCollectionPayload,
  evaluateRows,
  summarise,
  collectErrors,
  previewImport,
  runImport,
  buildTemplate
};
