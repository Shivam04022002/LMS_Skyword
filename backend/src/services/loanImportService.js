'use strict';

const { validationResult } = require('express-validator');
const { sequelize, Customer } = require('../models');
const ApiError = require('../utils/ApiError');
const spreadsheet = require('../utils/spreadsheet');
const auditService = require('./auditService');
const loanService = require('./loanService');
const loanPartyService = require('./loanPartyService');
const emiScheduleService = require('./emiScheduleService');
const { calculateLoanFinancials } = require('./loanCalculationService');
const loanValidator = require('../validators/loanValidator');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');
const { isValidCifId } = require('../config/customers');
const { LOAN_STATUS } = require('../config/loans');
const {
  MAX_ROWS,
  SHEET_NAME,
  TEMPLATE_FILENAME,
  CIF_LIST_SEPARATOR,
  COLUMNS,
  HEADER_TO_FIELD,
  BACKEND_OWNED_HEADERS,
  ROW_STATUS
} = require('../config/loanImport');

/**
 * Bulk loan import.
 *
 * The spreadsheet supplies TERMS and nothing else. Every rupee — interest,
 * total repayment, EMI amount, EMI count, the schedule and its dates — is
 * calculated by the existing loan and EMI services from those terms. There is
 * no second calculation engine here, and a workbook column that names a derived
 * value is refused outright.
 *
 * Rows are validated by the SAME express-validator chains the single loan
 * endpoint uses, and parties are resolved by the SAME loan-party rules, so an
 * import can never accept something the form would reject.
 *
 * Unlike the customer import, a loan import is ALL OR NOTHING: if any row fails
 * validation, nothing is written. Half a batch of loans is a worse outcome than
 * none.
 */

/** Splits "C000002, C000003" into ['C000002', 'C000003']. */
function parseCifList(value) {
  if (!value) return [];
  return String(value)
    .split(CIF_LIST_SEPARATOR)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

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
 * Resolves the CIFIDs on a row to customer ids.
 *
 * Existence and the active-customer rule come from the loan-party service, so
 * an imported loan is held to exactly the rules a hand-entered one is.
 */
async function resolveParties(values) {
  const errors = [];
  const applicantCif = values.applicantCif ? String(values.applicantCif).trim().toUpperCase() : null;

  const resolveOne = async (cifId, field) => {
    if (!isValidCifId(cifId)) {
      errors.push({ field, reason: `"${cifId}" is not a CIFID (expected C000001)` });
      return null;
    }
    const customer = await Customer.findOne({ where: { cifId } });
    if (!customer) {
      errors.push({ field, reason: `Customer ${cifId} not found` });
      return null;
    }
    try {
      loanPartyService.assertCustomerAssignable(customer);
    } catch (error) {
      errors.push({ field, reason: error.message });
      return null;
    }
    return customer;
  };

  if (!applicantCif) {
    errors.push({ field: 'applicantCif', reason: 'An applicant CIFID is required' });
  }

  const applicant = applicantCif ? await resolveOne(applicantCif, 'applicantCif') : null;

  const coApplicants = [];
  for (const cifId of parseCifList(values.coApplicantCifs)) {
    const customer = await resolveOne(cifId, 'coApplicantCifs');
    if (customer) coApplicants.push(customer);
  }

  const guarantors = [];
  for (const cifId of parseCifList(values.guarantorCifs)) {
    const customer = await resolveOne(cifId, 'guarantorCifs');
    if (customer) guarantors.push(customer);
  }

  // One customer, one role — the same rule loan creation enforces.
  const seen = new Map();
  [
    [applicant, 'applicantCif', 'applicant'],
    ...coApplicants.map((customer) => [customer, 'coApplicantCifs', 'co-applicant']),
    ...guarantors.map((customer) => [customer, 'guarantorCifs', 'guarantor'])
  ].forEach(([customer, field, role]) => {
    if (!customer) return;
    if (seen.has(customer.id)) {
      errors.push({ field, reason: `${customer.cifId} already appears on this loan as ${seen.get(customer.id)}` });
      return;
    }
    seen.set(customer.id, role);
  });

  return {
    errors,
    applicant,
    parties: {
      applicantCustomerId: applicant?.id,
      coApplicantCustomerIds: coApplicants.map((customer) => customer.id),
      guarantorCustomerIds: guarantors.map((customer) => customer.id)
    }
  };
}

/** The loan payload a row describes, in the shape the create endpoint accepts. */
function toLoanPayload(values, parties) {
  const payload = {
    ...parties,
    loanAmount: values.loanAmount,
    roi: values.roi,
    tenure: values.tenure === undefined ? undefined : Number(values.tenure),
    loanType: values.loanType ? String(values.loanType).trim().toUpperCase() : undefined,
    startDate: values.startDate
  };

  // Optional terms are omitted rather than sent blank, so the backend defaults
  // apply exactly as they do for a hand-entered loan.
  if (values.interestMethod) payload.interestMethod = String(values.interestMethod).trim().toUpperCase();
  if (values.tenureUnit) payload.tenureUnit = String(values.tenureUnit).trim().toUpperCase();
  if (values.weeklyOff) payload.weeklyOff = String(values.weeklyOff).trim().toUpperCase();
  if (values.collectionCount !== undefined && values.collectionCount !== null && values.collectionCount !== '') {
    payload.collectionCount = Number(values.collectionCount);
  }

  return payload;
}

/** Runs the real create-loan chains against one row's payload. */
async function validateTerms(payload) {
  const request = { body: { ...payload }, params: {}, query: {}, headers: {} };
  await Promise.all(loanValidator.createLoanRules.map((rule) => rule.run(request)));

  return validationResult(request)
    .array()
    .map((error) => ({ field: error.path, reason: error.msg }));
}

/** A signature for spotting the same loan written twice in one workbook. */
const rowSignature = (payload) =>
  [payload.applicantCustomerId, payload.loanAmount, payload.loanType, payload.tenure, payload.tenureUnit, payload.startDate].join('|');

/**
 * Validates every row: parties, then terms, then the figures the backend would
 * calculate from them.
 *
 * The calculation is the real one — `calculateLoanFinancials` — so a row whose
 * collection count cannot fit its contractual period is caught here, with the
 * service's own message, rather than at insert time.
 */
async function evaluateRows(rows) {
  const evaluated = [];
  const seen = new Map();

  for (const row of rows) {
    const errors = [];
    const { errors: partyErrors, parties, applicant } = await resolveParties(row.values);
    errors.push(...partyErrors);

    const payload = toLoanPayload(row.values, parties);

    // When the applicant could not be resolved the term rules also report a
    // missing applicant id. That is the same problem said twice, so the
    // downstream copy is dropped and the real reason stands alone.
    const termErrors = await validateTerms(payload);
    const applicantUnresolved = partyErrors.some((error) => error.field === 'applicantCif');
    errors.push(...termErrors.filter((error) => !(applicantUnresolved && error.field === 'applicantCustomerId')));

    let financials = null;
    if (errors.length === 0) {
      try {
        // The existing engine, read-only: the same numbers creation will store.
        financials = calculateLoanFinancials({
          loanAmount: payload.loanAmount,
          roi: payload.roi,
          tenure: payload.tenure,
          loanType: payload.loanType,
          startDate: payload.startDate,
          interestMethod: payload.interestMethod,
          weeklyOff: payload.weeklyOff,
          tenureUnit: payload.tenureUnit,
          collectionCount: payload.collectionCount ?? null
        });
      } catch (error) {
        errors.push({ field: 'collectionCount', reason: error.message });
      }
    }

    // The same loan written twice in one file is almost always a mistake. There
    // is no uniqueness rule on loans — a customer may legitimately hold several,
    // even on identical terms — so this is an in-file guard only, and nothing is
    // ever checked against, or blocked by, loans already in the database.
    let duplicate = false;
    if (errors.length === 0) {
      const signature = rowSignature(payload);
      if (seen.has(signature)) {
        duplicate = true;
        errors.push({ field: 'duplicate', reason: `Identical to row ${seen.get(signature)} in this file` });
      } else {
        seen.set(signature, row.rowNumber);
      }
    }

    evaluated.push({
      rowNumber: row.rowNumber,
      status: errors.length === 0 ? ROW_STATUS.VALID : duplicate ? ROW_STATUS.DUPLICATE : ROW_STATUS.INVALID,
      values: row.values,
      applicant: applicant ? { cifId: applicant.cifId, fullName: applicant.fullName } : null,
      payload,
      // Shown so the operator sees what the backend will store — never read back
      // from the spreadsheet.
      financials: financials
        ? {
            interest: financials.interest,
            totalRepayment: financials.totalRepayment,
            emiAmount: financials.emiAmount,
            emiCount: financials.emiCount,
            startDate: financials.startDate,
            endDate: financials.endDate,
            collectionCount: financials.collectionCount
          }
        : null,
      errors
    });
  }

  return evaluated;
}

function summarise(evaluated, blankRows) {
  return {
    totalRows: evaluated.length,
    validRows: evaluated.filter((row) => row.status === ROW_STATUS.VALID).length,
    invalidRows: evaluated.filter((row) => row.status === ROW_STATUS.INVALID).length,
    duplicateRows: evaluated.filter((row) => row.status === ROW_STATUS.DUPLICATE).length,
    blankRows
  };
}

const collectErrors = (evaluated) =>
  evaluated.flatMap((row) => row.errors.map((error) => ({ row: row.rowNumber, field: error.field, reason: error.reason })));

/**
 * Parses, validates and prices — and writes nothing at all.
 * There is no transaction, no create and no schedule generation in this path.
 */
async function previewImport(buffer, { filename } = {}) {
  const parsed = await parseWorkbook(buffer, { filename });
  const evaluated = await evaluateRows(parsed.rows);

  return {
    file: { name: parsed.filename, sheet: parsed.sheetName },
    summary: { ...summarise(evaluated, parsed.blankRows), importedRows: 0, previewOnly: true },
    rows: evaluated,
    errors: collectErrors(evaluated)
  };
}

/**
 * Imports a whole workbook, or none of it.
 *
 * The file is parsed and validated again from scratch — nothing from a previous
 * preview is trusted. If a single row is unusable the import is refused before
 * anything is written. Otherwise every loan, its parties and its EMI schedule
 * are created in ONE transaction, sequentially: loan numbers come from a locked
 * counter row, which serialises separate transactions but not two allocations
 * inside the same one, so the rows are inserted in turn.
 */
async function runImport(buffer, actor, context, { filename } = {}) {
  const parsed = await parseWorkbook(buffer, { filename });
  const evaluated = await evaluateRows(parsed.rows);
  const summary = summarise(evaluated, parsed.blankRows);

  if (summary.validRows !== summary.totalRows) {
    throw ApiError.badRequest(
      `This file has ${summary.totalRows - summary.validRows} unusable row(s) of ${summary.totalRows}. ` +
        'A loan import is all or nothing — fix the reported rows and upload the file again. Nothing was imported.'
    );
  }

  const created = await sequelize.transaction(async (transaction) => {
    const loans = [];

    for (const row of evaluated) {
      // The loan and its parties come from the loan service's own creation path,
      // so the loan number, the financial calculation and the party rules are
      // identical to a hand-entered loan.
      const loan = await loanService.createLoanRecord(row.payload, actor, transaction);

      // An imported loan is live: it is activated and its schedule generated by
      // the existing EMI service, exactly as pressing Activate would.
      await loan.update({ status: LOAN_STATUS.ACTIVE, updatedBy: actor.id }, { transaction });
      const schedule = await emiScheduleService.generateSchedule(loan.id, actor, { transaction });

      loans.push({ loan, emiCount: schedule.count, rowNumber: row.rowNumber });
    }

    return loans;
  });

  await auditService.record({
    ...context,
    action: AUDIT_ACTIONS.LOANS_IMPORTED,
    entity: AUDIT_ENTITIES.LOAN,
    entityId: null,
    details: {
      file: parsed.filename,
      sheet: parsed.sheetName,
      ...summary,
      importedRows: created.length,
      loanNumbers: created.map((entry) => entry.loan.loanNumber)
    }
  });

  return {
    file: { name: parsed.filename, sheet: parsed.sheetName },
    summary: { ...summary, importedRows: created.length, previewOnly: false },
    imported: created.map((entry) => ({
      row: entry.rowNumber,
      loanNumber: entry.loan.loanNumber,
      loanAmount: entry.loan.loanAmount,
      totalRepayment: entry.loan.totalRepayment,
      emiAmount: entry.loan.emiAmount,
      emiCount: entry.emiCount,
      status: entry.loan.status
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
    // ROI is text-formatted too: it stops Excel silently reformatting a typed
    // "5%" into a 0.05 percentage cell, which used to price a loan at a
    // hundredth of the intended rate with nothing to show for it. A plain "5"
    // still reads as a plain "5" — only the ambiguous percentage entry changes.
    textColumns: ['applicantCif', 'coApplicantCifs', 'guarantorCifs', 'roi', 'startDate'],
    notes: [
      {
        header: 'Calculated values',
        required: 'System',
        note:
          'Interest, total repayment, EMI amount, EMI count and the whole schedule are calculated by the system from ' +
          'these terms. Do not add columns for them — a file containing one is refused.'
      },
      {
        header: 'ROI',
        required: '',
        note:
          'The rate is PER MONTH. 5 means 5% a month. Enter it as a plain number — do not format the cell as a ' +
          'percentage (Excel stores "5%" as 0.05, which would price the loan at a hundredth of the intended rate).'
      },
      {
        header: 'Month contracts',
        required: '',
        note:
          'With Tenure Unit = MONTHS the contract runs from the start date to the same day N months later, and the ' +
          'interest is charged for those months. The collection count only decides how the repayment is collected.'
      },
      {
        header: 'On import',
        required: '',
        note: 'Imported loans are created ACTIVE and their EMI schedule is generated immediately.'
      },
      { header: 'Row limit', required: '', note: `At most ${MAX_ROWS} data rows per file. Delete the example row before importing.` },
      {
        header: 'All or nothing',
        required: '',
        note: 'If any row is unusable the whole file is refused and nothing is imported.'
      }
    ]
  });

  return { buffer, filename: TEMPLATE_FILENAME };
}

module.exports = {
  parseCifList,
  parseWorkbook,
  resolveParties,
  toLoanPayload,
  validateTerms,
  evaluateRows,
  summarise,
  collectErrors,
  previewImport,
  runImport,
  buildTemplate
};
