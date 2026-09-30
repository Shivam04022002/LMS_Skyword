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
 * ── COLLECTION DATE IS OPTIONAL, HERE ONLY ────────────────────────────────────
 * The Collection Date is the date the customer actually handed over the money.
 * When the operator leaves it blank the row is dated with the SYSTEM date —
 * today — because that is when an undated payment was received. It is never
 * derived from an instalment's due date: the instalments a payment settles say
 * nothing about when it was paid, and a customer paying three weeks ahead is
 * paying today.
 *
 * One collection therefore covers the whole row, with allocations across every
 * instalment it reaches, including instalments not yet due. Advance payments
 * are the point: `planFifoAllocation` has never filtered by date, so the plan
 * itself needed no change — only the date the resulting collection carries.
 *
 * An explicit Collection Date always wins outright and is validated by
 * `collectionService.assertCollectionDate` exactly as a manually posted
 * collection is, so a genuinely future payment date is still refused. A blank
 * date resolves to today and so can never fail that check.
 *
 * ── CONSEQUENCE FOR HISTORICAL BACKFILL, READ THIS ────────────────────────────
 * A BACKFILL MUST NOW GIVE AN EXPLICIT COLLECTION DATE ON EVERY ROW. Blanks in
 * a historical file will all be dated today, which is wrong for money received
 * months ago. This is a deliberate trade: dating a blank row from the
 * instalment it paid made advance payments — the far more common real case —
 * impossible to record at all, and it silently invented a payment date the
 * customer never transacted on. The date is now either stated or today, and
 * never guessed. Do not restore the derived-date behaviour.
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
const { today, differenceInDays } = require('../utils/dates');
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

const DATE_SOURCE = Object.freeze({ EXPLICIT: 'EXPLICIT', SYSTEM_DATE: 'SYSTEM_DATE' });

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

/**
 * Runs the real post-collection field rules against one row's payload.
 *
 * `collectionDate` is the one field oneBulk treats differently: a blank value
 * means "the customer paid today", not an error, so the
 * shared rule's "required" complaint is dropped for exactly that case. Every
 * other rule from the same chain — amount, ledger type, an actually-supplied
 * date's format — is unweakened, and a malformed (non-blank) date still fails
 * it normally.
 */
async function validateFields(payload) {
  const request = { body: { ...payload }, params: {}, query: {}, headers: {} };
  await Promise.all(collectionValidator.createCollectionRules.map((rule) => rule.run(request)));

  return validationResult(request)
    .array()
    .filter((error) => !String(error.path).startsWith('allocations'))
    .filter((error) => !(error.path === 'collectionDate' && !payload.collectionDate))
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
    // Left undefined when the cell was blank — `values.collectionDate` is only
    // present at all when the Excel cell held something. Deliberately NOT
    // defaulted to a placeholder here; the blank case is resolved later, per
    // instalment, once the allocation plan is known.
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
 * exactly as the file had it.
 *
 * A row with a blank date carries no date to compare — such rows (and any row
 * paired against one) keep their file position relative to one another,
 * exactly like same-date rows already do. This is deliberately conservative:
 * nothing here guesses at an order the file did not state. A blank row resolves
 * to today whatever position it ends up in, so this order cannot skew its date —
 * only which instalments are still outstanding by the time it is applied.
 */
function orderChronologically(rows) {
  return [...rows].sort((a, b) => {
    const loanA = a.loan?.id ?? `unresolved:${a.rowNumber}`;
    const loanB = b.loan?.id ?? `unresolved:${b.rowNumber}`;
    if (loanA !== loanB) return 0; // different loans: preserve file order (stable sort)

    const dateA = a.values.collectionDate ?? null;
    const dateB = b.values.collectionDate ?? null;
    if (dateA && dateB && dateA !== dateB) return dateA < dateB ? -1 : 1;

    return a.rowNumber - b.rowNumber;
  });
}

/**
 * The collection(s) a FIFO allocation plan must be written as.
 *
 * ONE collection, always — the whole payment, on the date it was received.
 *
 * The collection date is when the customer PAID. It is never taken from an
 * instalment: an EMI date says when money was due, not when it arrived, and
 * the two are different facts. A blank Collection Date therefore means "paid
 * today" and resolves to the system date, not to the date of whichever
 * instalment the money happens to settle.
 *
 * This previously split a blank-dated row into one collection per instalment
 * date, stamping each with its EMI's due date. That made an advance payment
 * impossible to record: paying three upcoming instalments produced three
 * collections dated in the future, and `assertCollectionDate` rejected the
 * row — the customer had genuinely paid today, but the import insisted the
 * payment happened on dates that had not arrived yet.
 *
 * Allocation is unchanged and still comes from `planFifoAllocation`: one
 * collection now simply carries allocations across every instalment the
 * payment reaches, including future-dated ones.
 */
function groupAllocationByDate({ plan, explicitDate, fallbackDate }) {
  return explicitDate
    ? [{ date: explicitDate, source: DATE_SOURCE.EXPLICIT, entries: plan }]
    : [{ date: fallbackDate, source: DATE_SOURCE.SYSTEM_DATE, entries: plan }];
}

const groupAmount = (entries) => fromPaise(entries.reduce((total, entry) => total + toPaise(entry.amount), 0n));

/**
 * PREVIEW DETAIL ONLY: what each planned allocation means in the operator's
 * terms — the instalment's due date, whether it is still to fall due, and what
 * that instalment will still owe afterwards.
 *
 * It decides nothing. `planFifoAllocation` remains the single authority on
 * which rupee lands where, and this only annotates the plan it produced, which
 * is why it lives here rather than in the shared planner: the permanent
 * collection import renders that planner's payload too, and its preview is not
 * changing.
 *
 * `future` is measured against the PAYMENT date, not against the due date of
 * anything else — an instalment not yet due when the money arrived is exactly
 * the advance payment this import exists to accept.
 */
function describeAllocation({ plan, emisById, collectedPaise, consumed, asOf }) {
  return plan.map((entry) => {
    const emi = emisById.get(Number(entry.emiId));
    const already = (collectedPaise.get(Number(entry.emiId)) ?? 0n) + (consumed.get(entry.emiId) ?? 0n);
    const outstandingBefore = allocationService.outstandingPaise(emi, already);

    return {
      emiId: entry.emiId,
      emiNumber: entry.emiNumber,
      amount: entry.amount,
      emiDate: emi.emiDate,
      future: differenceInDays(emi.emiDate, asOf) < 0,
      outstandingAfter: fromPaise(outstandingBefore - toPaise(entry.amount))
    };
  });
}

/** What makes two collections the same payment, for duplicate detection — per date-group, not per row. */
const groupSignature = (loanId, date, amount, paymentReference) =>
  [loanId, date, amount, (paymentReference ?? '').toUpperCase()].join('|');

/**
 * Validates and plans every row, in chronological order per loan.
 *
 * Nothing here writes. Duplicate protection reuses the existing collection
 * schema's own identity signal — loan, date, amount and reference — the same
 * one the permanent import uses, rather than inventing a new one — checked
 * against the date the row actually resolves to, since that is what will be
 * compared against the ledger at commit time.
 */
async function evaluateRows(rows, { asOf = today() } = {}) {
  /*
   * Instalments and their ledger balances, once per loan. Nothing in this
   * function writes, so what the ledger says cannot change underneath it; the
   * rows already walked are accounted for by `consumed` instead.
   */
  const emiDetailCache = new Map();
  async function loanEmiDetail(loanId) {
    if (!emiDetailCache.has(loanId)) {
      const emis = await EmiSchedule.findAll({
        where: { loanId },
        attributes: ['id', 'emiNumber', 'emiDate', 'emiAmount'],
        order: [['emiNumber', 'ASC']]
      });
      emiDetailCache.set(loanId, {
        emisById: new Map(emis.map((emi) => [emi.id, emi])),
        collectedPaise: await allocationService.calculateCollectedByEmi(emis.map((emi) => emi.id))
      });
    }
    return emiDetailCache.get(loanId);
  }

  const resolved = [];
  for (const row of rows) {
    const { errors, loan, payer } = await resolveRow(row.values);
    resolved.push({ ...row, resolveErrors: errors, loan, payer });
  }

  const ordered = orderChronologically(resolved);

  const evaluated = [];
  const seen = new Map(); // group signature -> "row N"
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
    }

    let allocation = null;
    let dateGroups = null;

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

        // Blank means "paid today"; an explicit date is the date given.
        const groups = groupAllocationByDate({
          plan,
          explicitDate: payload.collectionDate,
          fallbackDate: asOf
        });

        /*
         * The same rule an explicit date has always obeyed: no advance
         * collections. A blank date resolves to today and so always passes —
         * only a date the operator actually typed can fail here now. The
         * INSTALMENT dates this payment settles are not checked at all: an
         * advance payment for future instalments is exactly the case this
         * import has to support.
         */
        for (const group of groups) {
          try {
            collectionService.assertCollectionDate(group.date, asOf);
          } catch (error) {
            errors.push({ field: 'collectionDate', reason: error.message });
          }
        }

        if (errors.length === 0) {
          // Annotated for display before `consumed` moves on, so each row's
          // "still owing" figure reflects the rows above it and not itself.
          const { emisById, collectedPaise } = await loanEmiDetail(payload.loanId);
          dateGroups = groups.map((group) => ({
            ...group,
            entries: describeAllocation({ plan: group.entries, emisById, collectedPaise, consumed, asOf })
          }));

          plan.forEach((entry) => {
            consumed.set(entry.emiId, (consumed.get(entry.emiId) ?? 0n) + toPaise(entry.amount));
          });
        }
      }
    }

    let duplicate = false;
    if (errors.length === 0 && dateGroups) {
      for (const group of dateGroups) {
        const amount = groupAmount(group.entries);
        const signature = groupSignature(payload.loanId, group.date, amount, payload.paymentReference);

        if (seen.has(signature)) {
          duplicate = true;
          errors.push({
            field: 'duplicate',
            reason: `The ${group.date} portion of this row is identical to ${seen.get(signature)} in this file`
          });
          continue;
        }
        seen.set(signature, `row ${row.rowNumber}`);

        const existing = await Collection.findOne({
          where: {
            loanId: payload.loanId,
            collectionDate: group.date,
            amount,
            status: COLLECTION_STATUS.POSTED,
            ...(payload.paymentReference ? { paymentReference: payload.paymentReference } : { paymentReference: { [Op.is]: null } })
          }
        });

        if (existing) {
          duplicate = true;
          errors.push({
            field: 'duplicate',
            reason: `The ${group.date} portion of this row is already posted as ${existing.collectionNumber} (same loan, date, amount and reference)`
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
      // Present only for a valid row: how it will actually be written — one
      // entry per collection that will be created — one, always. `source` tells
      // the UI whether to label the date "(explicit)" or "(today)".
      dateGroups:
        errors.length === 0 && dateGroups
          ? dateGroups.map((group) => ({
              date: group.date,
              source: group.source,
              amount: groupAmount(group.entries),
              allocations: group.entries.map((entry) => ({
                emiId: entry.emiId,
                emiNumber: entry.emiNumber,
                amount: entry.amount,
                emiDate: entry.emiDate,
                future: entry.future,
                outstandingAfter: entry.outstandingAfter
              }))
            }))
          : null,
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
 * preview planned against, inside ONE transaction. Each row writes a single
 * collection through `collectionService.createCollectionRecord` — the same
 * function a manual posting and the permanent import both use — so the
 * eligibility rules, the allocation validation, the collection numbering and
 * the EMI snapshot rebuild cannot drift from either of them, and a failure on
 * any one row rolls back everything this import has written so far.
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

      // Re-planned inside the transaction: the rows above (and any date-group
      // already written for this same row) have already moved the ledger.
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

      const groups = groupAllocationByDate({
        plan,
        explicitDate: row.payload.collectionDate,
        fallbackDate: asOf
      });

      for (const group of groups) {
        collectionService.assertCollectionDate(group.date, asOf);

        const collection = await collectionService.createCollectionRecord(
          {
            ...row.payload,
            // The row's own `amount` is the WHOLE payment; each collection
            // this splits into must carry only its own date-group's share.
            amount: groupAmount(group.entries),
            collectionDate: group.date,
            allocations: group.entries.map((entry) => ({ emiId: entry.emiId, amount: entry.amount }))
          },
          actor,
          transaction,
          { asOf }
        );

        collections.push({ collection, plan: group.entries, rowNumber: row.rowNumber, dateSource: group.source });
      }
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
    // createCollectionRecord already enforces this per collection via
    // assertAllocationTotal; this is a defence-in-depth aggregate check, not a
    // second calculation of anything.
    throw ApiError.internal('Collection total does not equal allocation total — the import was not committed cleanly');
  }

  const affectedEmiIds = [...new Set(created.flatMap((entry) => entry.plan.map((allocation) => allocation.emiId)))];
  const affectedEmis = await EmiSchedule.findAll({ where: { id: affectedEmiIds }, attributes: ['id', 'status', 'loanId'] });
  const fullyPaidEmis = affectedEmis.filter((emi) => emi.status === EMI_STATUS.PAID).length;
  const partiallyPaidEmis = affectedEmis.filter((emi) => emi.status === EMI_STATUS.PARTIAL).length;
  const affectedLoanIds = [...new Set(affectedEmis.map((emi) => emi.loanId))];
  const systemDatedCollections = created.filter((entry) => entry.dateSource === DATE_SOURCE.SYSTEM_DATE).length;

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
      importedRows: summary.validRows,
      collectionsCreated: created.length,
      importedAmount: fromPaise(importedPaise),
      collectionNumbers: created.map((entry) => entry.collection.collectionNumber),
      // Distinguishes an explicitly-dated posting from one dated with the
      // system date, without touching any existing audit record.
      explicitDateCollections: created.length - systemDatedCollections,
      systemDatedCollections,
      ...reconciliation
    }
  });

  return {
    file: { name: parsed.filename, sheet: parsed.sheetName },
    summary: {
      ...summary,
      importedRows: summary.validRows,
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
        dateSource: entry.dateSource,
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
        header: 'Collection Date',
        required: '',
        note:
          'Optional — this is the date the customer actually paid. Leave it blank and today\'s date is used. It is ' +
          'never taken from an instalment due date, so paying instalments that are not due yet is fine: the payment ' +
          'is dated today and allocated across every one of them. BACKFILLING A PAST PAYMENT? Fill this in on every ' +
          'row — a blank is dated today, not on the date the money was actually received.'
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
          'in the file. Rows on the same date, or with no date, keep their file order.'
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
  DATE_SOURCE,
  parseWorkbook,
  validateFields,
  resolveRow,
  toCollectionPayload,
  orderChronologically,
  groupAllocationByDate,
  evaluateRows,
  summarise,
  collectErrors,
  previewImport,
  runImport,
  buildTemplate
};
