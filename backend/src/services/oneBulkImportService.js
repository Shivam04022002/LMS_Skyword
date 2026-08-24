'use strict';

/*
 * TEMPORARY: oneBulk historical collection migration utility.
 * Can be removed after historical collections are migrated.
 *
 * This service exists to backfill collections that were actually received
 * before this loan went live on the LMS, so the historical EMI ledger reads
 * correctly. It is a thin orchestration layer only: every rupee is still
 * planned by `collectionAllocationService.planFifoAllocation` and every write
 * still goes through `collectionService.createCollectionRecord` — the exact
 * same functions the permanent collection import and the Post Collection
 * screen use. Nothing here recomputes principal, interest, outstanding, DPD or
 * payment status; that logic lives in one place and this file does not
 * duplicate it.
 *
 * Isolation: nothing in `collectionService.js`, `collectionImportService.js`,
 * `collectionAllocationService.js` or `collectionValidator.js` imports from
 * this file. Removing every `oneBulk*` file, the `ONE_BULK_IMPORTED` audit
 * constant and the two lines that mount its route and its nav entry removes
 * the feature without touching the normal collection workflow at all.
 */

const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const { sequelize, Loan, Customer, LoanParty, Collection, EmiSchedule } = require('../models');
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
const { EMI_STATUS } = require('../config/emis');
const {
  MAX_ROWS,
  SHEET_NAME,
  TEMPLATE_FILENAME,
  COLUMNS,
  HEADER_TO_FIELD,
  BACKEND_OWNED_HEADERS,
  ROW_STATUS
} = require('../config/oneBulk');

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

/** Runs the real post-collection field rules against one row's payload. */
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
 * Resolves the loan and the payer named by a row, using the CURRENT loan
 * number and the existing eligibility rule: the payer must be an active party
 * to that loan (applicant, co-applicant or guarantor), exactly as a manual
 * posting or the permanent import requires.
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
      errors.push({ field: 'loanNumber', reason: `Loan ${loanNumber} not found (use the loan's current number)` });
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

/** The collection payload a row describes, in the shape the posting service accepts. */
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

/**
 * Orders parsed rows for processing: chronologically by collection date WITHIN
 * each loan, oldest first, so a later payment can never be planned against an
 * instalment before an earlier one for the same loan gets its turn. Rows on
 * different loans never affect each other, so their relative order is left
 * exactly as the file had it — a plain stable sort (guaranteed by
 * `Array.prototype.sort` in Node) gives both properties from one comparator.
 * Rows whose loan could not be resolved keep their file position; they cannot
 * be allocated against anything regardless of order.
 */
function orderChronologically(rows) {
  return [...rows].sort((a, b) => {
    const loanA = a.loan?.id ?? `unresolved:${a.rowNumber}`;
    const loanB = b.loan?.id ?? `unresolved:${b.rowNumber}`;
    if (loanA !== loanB) return 0; // different loans: preserve file order (stable sort)

    const dateA = a.values.collectionDate ?? '';
    const dateB = b.values.collectionDate ?? '';
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;

    return a.rowNumber - b.rowNumber;
  });
}

/** What makes two rows the same payment, for duplicate detection. */
const rowSignature = (payload) =>
  [payload.loanId, payload.collectionDate, payload.amount, (payload.paymentReference ?? '').toUpperCase()].join('|');

/**
 * Validates and plans every row, in chronological order per loan.
 *
 * Nothing here writes. Duplicate protection reuses the existing collection
 * schema's own identity signal — loan, date, amount and reference — the same
 * one the permanent import uses, rather than inventing a new one: a genuine
 * second payment of the same amount on the same day is told apart from an
 * accidental re-upload by its reference, exactly as it already is elsewhere in
 * the system.
 */
async function evaluateRows(rows, { asOf = today() } = {}) {
  // Resolve every row's loan/payer first, so the chronological sort can group
  // by the resolved loan id rather than the raw loan-number text.
  const resolved = [];
  for (const row of rows) {
    const { errors, loan, payer } = await resolveRow(row.values);
    resolved.push({ ...row, resolveErrors: errors, loan, payer });
  }

  const ordered = orderChronologically(resolved);

  const evaluated = [];
  const seen = new Map();
  // emiId -> paise already taken by earlier (chronologically) rows in this file.
  const consumed = new Map();

  for (const row of ordered) {
    const errors = [...row.resolveErrors];
    const { loan, payer } = row;

    const payload = toCollectionPayload(row.values, { loan, payer });

    const fieldErrors = await validateFields(payload);
    const loanUnresolved = row.resolveErrors.some((error) => error.field === 'loanNumber');
    const payerUnresolved = row.resolveErrors.some((error) => error.field === 'payerCif');
    errors.push(
      ...fieldErrors.filter(
        (error) => !(loanUnresolved && error.field === 'loanId') && !(payerUnresolved && error.field === 'customerId')
      )
    );

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
        errors.push({
          field: 'amount',
          reason:
            plan.length === 0
              ? 'This loan has nothing outstanding to collect against, as of the payments already accounted for'
              : `${unallocated} of this payment cannot be allocated — only ${fromPaise(
                  toPaise(payload.amount) - toPaise(unallocated)
                )} of it is still outstanding at this point in the payment history`
        });
      } else {
        allocation = plan;
        plan.forEach((entry) => {
          consumed.set(entry.emiId, (consumed.get(entry.emiId) ?? 0n) + toPaise(entry.amount));
        });
      }
    }

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
      allocation,
      errors
    });
  }

  // Restored to the file's own row order for display — the sort above only
  // controlled processing order, not what the operator sees.
  return evaluated.sort((a, b) => a.rowNumber - b.rowNumber);
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

/** Parses, validates and plans — writes nothing at all. */
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
 * Re-parsed and re-validated from scratch — nothing from a previous preview is
 * trusted. Rows are posted in the same chronological-per-loan order the
 * preview planned against, inside ONE transaction: each row's allocation is
 * re-planned against the live ledger (which now includes every row already
 * posted earlier in this same import), and written through
 * `collectionService.createCollectionRecord` — the same function a manual
 * posting and the permanent import both use, so the eligibility rules, the
 * allocation validation, the collection numbering and the EMI snapshot rebuild
 * cannot drift from either of them.
 */
async function runImport(buffer, actor, context, { filename, asOf = today() } = {}) {
  const parsed = await parseWorkbook(buffer, { filename });
  const evaluated = await evaluateRows(parsed.rows, { asOf });
  const summary = summarise(evaluated, parsed.blankRows);

  if (summary.validRows !== summary.totalRows) {
    throw ApiError.badRequest(
      `This file has ${summary.totalRows - summary.validRows} unusable row(s) of ${summary.totalRows}. ` +
        'A oneBulk import is all or nothing — fix the reported rows and upload the file again. Nothing was posted.'
    );
  }

  // Re-establish the chronological-per-loan processing order for the write
  // phase — `evaluateRows` returns rows in file order for display.
  const ordered = orderChronologically(
    evaluated.map((row) => ({
      rowNumber: row.rowNumber,
      values: row.values,
      loan: row.loan ? { id: row.payload.loanId } : null
    }))
  );
  const byRowNumber = new Map(evaluated.map((row) => [row.rowNumber, row]));

  const created = await sequelize.transaction(async (transaction) => {
    const collections = [];

    for (const orderedRow of ordered) {
      const row = byRowNumber.get(orderedRow.rowNumber);

      const { plan, unallocated } = await allocationService.planFifoAllocation({
        loanId: row.payload.loanId,
        amount: row.payload.amount,
        transaction
      });

      if (toPaise(unallocated) > 0n) {
        throw ApiError.conflict(
          `Row ${row.rowNumber}: ${unallocated} of this payment cannot be allocated at the time it is applied. Nothing was posted.`
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

  // --- Reconciliation: verify what was actually written, not just what was planned. ---
  const importedPaise = created.reduce((total, entry) => total + toPaise(entry.collection.amount), 0n);
  const allocatedPaise = created.reduce(
    (total, entry) => total + entry.plan.reduce((sum, allocation) => sum + toPaise(allocation.amount), 0n),
    0n
  );
  if (importedPaise !== allocatedPaise) {
    // createCollectionRecord already enforces this per row via
    // assertAllocationTotal; this is a defence-in-depth aggregate check, not a
    // second calculation of anything.
    throw ApiError.internal('Collection total does not equal allocation total — the import was not committed cleanly');
  }

  const affectedEmiIds = [...new Set(created.flatMap((entry) => entry.plan.map((allocation) => allocation.emiId)))];
  const affectedEmis = await EmiSchedule.findAll({ where: { id: affectedEmiIds }, attributes: ['id', 'status', 'loanId'] });
  const fullyPaidEmis = affectedEmis.filter((emi) => emi.status === EMI_STATUS.PAID).length;
  const partiallyPaidEmis = affectedEmis.filter((emi) => emi.status === EMI_STATUS.PARTIAL).length;
  const affectedLoanIds = [...new Set(affectedEmis.map((emi) => emi.loanId))];

  const reconciliation = {
    collectionAmountEqualsAllocationTotal: importedPaise === allocatedPaise,
    loansAffected: affectedLoanIds.length,
    emisAffected: affectedEmiIds.length,
    fullyPaidEmis,
    partiallyPaidEmis
  };

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.ONE_BULK_IMPORTED,
    entity: AUDIT_ENTITIES.COLLECTION,
    entityId: null,
    details: {
      file: parsed.filename,
      sheet: parsed.sheetName,
      ...summary,
      importedRows: created.length,
      importedAmount: fromPaise(importedPaise),
      collectionNumbers: created.map((entry) => entry.collection.collectionNumber),
      ...reconciliation
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
    imported: created
      .slice()
      .sort((a, b) => a.rowNumber - b.rowNumber)
      .map((entry) => ({
        row: entry.rowNumber,
        collectionNumber: entry.collection.collectionNumber,
        amount: entry.collection.amount,
        collectionDate: entry.collection.collectionDate,
        allocations: entry.plan.map((allocation) => ({ emiNumber: allocation.emiNumber, amount: allocation.amount }))
      })),
    reconciliation,
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
        header: 'oneBulk',
        required: '',
        note:
          'TEMPORARY: for backfilling collections that were actually received before this loan went live on the ' +
          'LMS. Use the loan\'s CURRENT loan number.'
      },
      {
        header: 'Allocation',
        required: 'System',
        note:
          'The system allocates each payment across the outstanding instalments, oldest first. Do not add ' +
          'allocation, EMI, outstanding or status columns — a file containing one is refused.'
      },
      {
        header: 'Order',
        required: '',
        note:
          'Multiple rows for the same loan are applied oldest Collection Date first, regardless of where they sit ' +
          'in the file. Rows on the same date keep their file order.'
      },
      {
        header: 'Duplicates',
        required: '',
        note:
          'A row matching a posted collection on loan, date, amount and reference is treated as already posted. ' +
          'Give two genuine payments of the same amount on the same day different references.'
      },
      { header: 'Row limit', required: '', note: `At most ${MAX_ROWS} data rows per file.` },
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
  orderChronologically,
  evaluateRows,
  summarise,
  collectErrors,
  previewImport,
  runImport,
  buildTemplate
};
