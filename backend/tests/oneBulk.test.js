'use strict';

/*
 * TEMPORARY: tests for the oneBulk historical collection migration utility.
 *
 *   npm run test:onebulk
 *
 * Kept as its own file, separate from tests/offline.test.js, for the same
 * reason the feature itself is isolated: this whole file can be deleted when
 * oneBulk is removed, without touching the permanent test suite.
 *
 * This suite creates real fixtures (two throwaway customers and loans) in
 * whatever database `backend/.env` points at, exercises the real service
 * end-to-end — including actual commits through `runImport` — and deletes
 * every row it created at the end, verifying the database returns to its
 * exact starting counts. It is not offline: it needs the same MySQL
 * connection the application itself uses.
 */

const ExcelJS = require('exceljs');
const { sequelize, User, Customer, Loan, LoanParty, EmiSchedule, Collection, CollectionAllocation } = require('../src/models');
const customerService = require('../src/services/customerService');
const loanService = require('../src/services/loanService');
const emiScheduleService = require('../src/services/emiScheduleService');
const collectionService = require('../src/services/collectionService');
const oneBulkImportService = require('../src/services/oneBulkImportService');
const oneBulkConfig = require('../src/config/oneBulk');
const { LOAN_STATUS } = require('../src/config/loans');
const { EMI_STATUS } = require('../src/config/emis');
const { today, addDays } = require('../src/utils/dates');

// The system date the service itself resolves a blank Collection Date to.
const TODAY = today();

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

async function buildWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(oneBulkConfig.SHEET_NAME);
  sheet.addRow(oneBulkConfig.COLUMNS.map((column) => column.header));
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const row = ({ loan, cif, amount, date, mode = 'CASH', ref = '', notes = '' }) => [loan, cif, amount, date, mode, ref, notes];

(async () => {
  const actor = { id: 1, ipAddress: '127.0.0.1' };
  const context = { actorId: 1, ipAddress: '127.0.0.1' };
  const createdCollectionIds = [];
  let customerA;
  let customerB;
  let loanA;
  let loanB;

  try {
    // ---------- fixtures ----------
    await sequelize.transaction(async (transaction) => {
      customerA = await customerService.createCustomerRecord({ firstName: 'OneBulk Test A', mobile: '9000000001' }, actor, transaction);
      customerB = await customerService.createCustomerRecord({ firstName: 'OneBulk Test B', mobile: '9000000002' }, actor, transaction);

      loanA = await loanService.createLoanRecord(
        {
          applicantCustomerId: customerA.id,
          loanAmount: '5000',
          roi: '0',
          tenure: 5,
          loanType: 'MONTHLY',
          startDate: '2026-01-01',
          interestMethod: 'FLAT'
        },
        actor,
        transaction
      );
      await loanA.update({ status: LOAN_STATUS.ACTIVE }, { transaction });

      loanB = await loanService.createLoanRecord(
        {
          applicantCustomerId: customerB.id,
          loanAmount: '12000',
          roi: '0',
          tenure: 12,
          loanType: 'MONTHLY',
          startDate: '2025-08-01',
          interestMethod: 'FLAT'
        },
        actor,
        transaction
      );
      await loanB.update({ status: LOAN_STATUS.ACTIVE }, { transaction });
    });

    await emiScheduleService.generateSchedule(loanA.id, actor);
    await emiScheduleService.generateSchedule(loanB.id, actor);

    const emiA = async () => EmiSchedule.findAll({ where: { loanId: loanA.id }, order: [['emiNumber', 'ASC']] });
    const emiB = async () => EmiSchedule.findAll({ where: { loanId: loanB.id }, order: [['emiNumber', 'ASC']] });

    // ---------- Test 1: full EMI payment ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanA.loanNumber, cif: customerA.cifId, amount: 1000, date: '2026-07-01' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 't1.xlsx' });
      createdCollectionIds.push(...result.imported.map((entry) => entry.collectionNumber));
      const emis = await emiA();
      record(
        'Test 1 — full EMI payment marks the instalment PAID with zero outstanding',
        result.summary.importedRows === 1 &&
          emis[0].status === EMI_STATUS.PAID &&
          Number(emis[0].amountCollected) === 1000 &&
          Number(emis[0].emiAmount) - Number(emis[0].amountCollected) === 0,
        `EMI1 status=${emis[0].status} collected=${emis[0].amountCollected} emiAmount=${emis[0].emiAmount}`
      );
    }

    // ---------- Test 2: partial EMI payment ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanA.loanNumber, cif: customerA.cifId, amount: 600, date: '2026-07-02' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 't2.xlsx' });
      const emis = await emiA();
      record(
        'Test 2 — partial EMI payment leaves it PARTIAL with the correct outstanding, not marked fully paid',
        result.summary.importedRows === 1 &&
          emis[1].status === EMI_STATUS.PARTIAL &&
          Number(emis[1].amountCollected) === 600 &&
          Number(emis[1].emiAmount) - Number(emis[1].amountCollected) === 400,
        `EMI2 status=${emis[1].status} collected=${emis[1].amountCollected} outstanding=${Number(emis[1].emiAmount) - Number(emis[1].amountCollected)}`
      );
    }

    // ---------- Test 13 (checked here, right after the partial payment it verifies) ----------
    {
      const emis = await emiA();
      record(
        'Test 13 — EMI outstanding reconciles as emiAmount - amountCollected for a partially paid instalment',
        Number(emis[1].emiAmount) - Number(emis[1].amountCollected) === 400,
        `1000 - 600 = ${Number(emis[1].emiAmount) - Number(emis[1].amountCollected)}`
      );
    }

    // ---------- Test 10: duplicate upload protection (in-file, and against an already-posted row) ----------
    // Runs here, before Test 3 exhausts loan A's outstanding, so a duplicate
    // row is rejected for BEING a duplicate rather than for having nothing
    // left to allocate against.
    {
      // A fresh, never-posted row, repeated twice in one file.
      const freshRow = row({ loan: loanA.loanNumber, cif: customerA.cifId, amount: 100, date: '2026-07-10' });
      const inFileDup = await buildWorkbook([freshRow, freshRow]);
      const previewInFile = await oneBulkImportService.previewImport(inFileDup, { filename: 't10a.xlsx' });

      // Test 1's exact row, already posted — re-uploaded on its own.
      const alreadyPostedRow = row({ loan: loanA.loanNumber, cif: customerA.cifId, amount: 1000, date: '2026-07-01' });
      const againstPosted = await buildWorkbook([alreadyPostedRow]);
      const previewAgainstPosted = await oneBulkImportService.previewImport(againstPosted, { filename: 't10b.xlsx' });

      record(
        'Test 10 — an identical row repeated in one file is flagged as an in-file duplicate',
        previewInFile.rows[0].status === 'VALID' && previewInFile.rows[1].status === 'DUPLICATE',
        `row1=${previewInFile.rows[0].status} row2=${previewInFile.rows[1].status}`
      );
      record(
        'Test 10 — re-uploading a row that was already posted is flagged as already posted, not re-imported',
        previewAgainstPosted.rows[0].status === 'DUPLICATE' &&
          /already posted as/i.test(previewAgainstPosted.rows[0].errors[0]?.reason ?? ''),
        JSON.stringify(previewAgainstPosted.rows[0].errors)
      );
    }

    // ---------- Test 3: one payment spanning multiple EMIs (completes EMI2, then fully pays EMI3-5) ----------
    let test3Reconciliation;
    {
      const buffer = await buildWorkbook([row({ loan: loanA.loanNumber, cif: customerA.cifId, amount: 3400, date: '2026-07-03' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 't3.xlsx' });
      createdCollectionIds.push(...result.imported.map((entry) => entry.collectionNumber));
      test3Reconciliation = result.reconciliation;
      const emis = await emiA();
      const allPaid = emis.every((emi) => emi.status === EMI_STATUS.PAID);
      const totalCollected = emis.reduce((total, emi) => total + Number(emi.amountCollected), 0);
      record(
        'Test 3 — one payment spanning multiple EMIs completes the partial one and fully pays the rest, oldest first',
        result.imported[0].allocations.length === 4 && // EMI2 remainder + EMI3 + EMI4 + EMI5
          allPaid &&
          totalCollected === 5000,
        `allocations=${JSON.stringify(result.imported[0].allocations)} totalCollected=${totalCollected}`
      );
    }

    // ---------- Test 12: collection amount = allocation total ----------
    record(
      'Test 12 — reconciliation confirms collection amount equals allocation total',
      test3Reconciliation.collectionAmountEqualsAllocationTotal === true,
      JSON.stringify(test3Reconciliation)
    );

    // ---------- Test 5: wrong loan number ----------
    {
      const buffer = await buildWorkbook([row({ loan: 'LN26-999999', cif: customerA.cifId, amount: 100, date: '2026-07-01' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 't5.xlsx' });
      record(
        'Test 5 — a loan number that does not exist is rejected',
        preview.rows[0].status === 'INVALID' && preview.rows[0].errors.some((e) => e.field === 'loanNumber'),
        JSON.stringify(preview.rows[0].errors)
      );
    }

    // ---------- Test 6: wrong CIFID (a real customer, but not a party to this loan) ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanA.loanNumber, cif: customerB.cifId, amount: 100, date: '2026-07-01' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 't6.xlsx' });
      record(
        'Test 6 — a real CIFID that is not a party to the named loan is rejected',
        preview.rows[0].status === 'INVALID' &&
          preview.rows[0].errors.some((e) => e.field === 'payerCif' && /not a party/.test(e.reason)),
        JSON.stringify(preview.rows[0].errors)
      );
    }

    // ---------- Test 7: invalid amount ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanB.loanNumber, cif: customerB.cifId, amount: 0, date: '2026-07-01' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 't7.xlsx' });
      record(
        'Test 7 — a zero/invalid amount is rejected',
        preview.rows[0].status === 'INVALID' && preview.rows[0].errors.some((e) => e.field === 'amount'),
        JSON.stringify(preview.rows[0].errors)
      );
    }

    // ---------- Test 8: invalid payment mode ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanB.loanNumber, cif: customerB.cifId, amount: 100, date: '2026-07-01', mode: 'UPI' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 't8.xlsx' });
      record(
        'Test 8 — a payment mode outside CASH/BANK is rejected',
        preview.rows[0].status === 'INVALID' && preview.rows[0].errors.some((e) => e.field === 'ledgerType'),
        JSON.stringify(preview.rows[0].errors)
      );
    }

    // ---------- Test 9: invalid (future) collection date ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanB.loanNumber, cif: customerB.cifId, amount: 100, date: '2099-01-01' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 't9.xlsx' });
      record(
        'Test 9 — a future collection date is rejected (advance collections are not supported)',
        preview.rows[0].status === 'INVALID' && preview.rows[0].errors.some((e) => e.field === 'collectionDate'),
        JSON.stringify(preview.rows[0].errors)
      );
    }

    // ---------- Test 4: multiple historical payments on the same loan, applied chronologically regardless of file order ----------
    {
      // File order deliberately scrambled: Aug, then Jul-01, then Jul-15.
      const buffer = await buildWorkbook([
        row({ loan: loanB.loanNumber, cif: customerB.cifId, amount: 4000, date: '2026-08-01' }),
        row({ loan: loanB.loanNumber, cif: customerB.cifId, amount: 5000, date: '2026-07-01' }),
        row({ loan: loanB.loanNumber, cif: customerB.cifId, amount: 3000, date: '2026-07-15' })
      ]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 't4.xlsx' });
      createdCollectionIds.push(...result.imported.map((entry) => entry.collectionNumber));

      const byDate = new Map(result.imported.map((entry) => [entry.collectionDate, entry.allocations.map((a) => a.emiNumber)]));
      const jul01 = byDate.get('2026-07-01') ?? [];
      const jul15 = byDate.get('2026-07-15') ?? [];
      const aug01 = byDate.get('2026-08-01') ?? [];

      record(
        'Test 4 — payments for the same loan are applied oldest-date-first regardless of Excel row order',
        JSON.stringify(jul01) === JSON.stringify([1, 2, 3, 4, 5]) &&
          JSON.stringify(jul15) === JSON.stringify([6, 7, 8]) &&
          JSON.stringify(aug01) === JSON.stringify([9, 10, 11, 12]),
        `2026-07-01 -> EMI ${JSON.stringify(jul01)}, 2026-07-15 -> EMI ${JSON.stringify(jul15)}, 2026-08-01 -> EMI ${JSON.stringify(aug01)}`
      );
    }

    // ---------- Test 11: transactional rollback ----------
    // A normal (non-oneBulk) collection races in and consumes the whole of a
    // fresh loan between the oneBulk file being prepared and it being run, so
    // the re-plan inside runImport's transaction finds nothing left for its
    // first row. The whole import must fail, and NOTHING from it may commit —
    // not even the rows that would otherwise have succeeded.
    {
      let customerC;
      let loanC;
      await sequelize.transaction(async (transaction) => {
        customerC = await customerService.createCustomerRecord({ firstName: 'OneBulk Test C', mobile: '9000000003' }, actor, transaction);
        loanC = await loanService.createLoanRecord(
          {
            applicantCustomerId: customerC.id,
            loanAmount: '2000',
            roi: '0',
            tenure: 2,
            loanType: 'MONTHLY',
            startDate: '2026-01-01',
            interestMethod: 'FLAT'
          },
          actor,
          transaction
        );
        await loanC.update({ status: LOAN_STATUS.ACTIVE }, { transaction });
      });
      await emiScheduleService.generateSchedule(loanC.id, actor);

      const buffer = await buildWorkbook([
        row({ loan: loanC.loanNumber, cif: customerC.cifId, amount: 1000, date: '2026-07-01' }),
        row({ loan: loanC.loanNumber, cif: customerC.cifId, amount: 1000, date: '2026-07-15' })
      ]);

      // The race: a normal collection consumes the whole loan first, planned
      // the same way a manual post would be (allocations are explicit for
      // createCollection — planFifoAllocation just derives what they'd be).
      const allocationService = require('../src/services/collectionAllocationService');
      const { plan: interloperPlan } = await allocationService.planFifoAllocation({ loanId: loanC.id, amount: '2000' });
      const interloper = await collectionService.createCollection(
        {
          loanId: loanC.id,
          customerId: customerC.id,
          amount: '2000',
          collectionDate: '2026-06-20',
          ledgerType: 'CASH',
          allocations: interloperPlan.map((entry) => ({ emiId: entry.emiId, amount: entry.amount }))
        },
        actor,
        context
      );
      createdCollectionIds.push(interloper.collectionNumber);

      let threw = null;
      try {
        await oneBulkImportService.runImport(buffer, actor, context, { filename: 't11.xlsx' });
      } catch (error) {
        threw = error;
      }

      const collectionsOnLoanC = await Collection.count({ where: { loanId: loanC.id } });
      record(
        'Test 11 — when the live ledger no longer matches the plan, runImport throws and posts nothing at all',
        threw !== null && collectionsOnLoanC === 1, // only the interloper's collection, none from oneBulk
        `threw=${threw?.message} collectionsOnLoanC=${collectionsOnLoanC} (expected 1, the interloper only)`
      );

      // cleanup for loan C
      const emisC = await EmiSchedule.findAll({ where: { loanId: loanC.id } });
      await CollectionAllocation.destroy({ where: { emiId: emisC.map((e) => e.id) } });
      await Collection.destroy({ where: { loanId: loanC.id } });
      await EmiSchedule.destroy({ where: { loanId: loanC.id } });
      await LoanParty.destroy({ where: { loanId: loanC.id } });
      await loanC.destroy();
      await customerC.destroy();
    }

    // =====================================================================
    // Blank Collection Date: the payment date is TODAY, never an EMI due date
    // =====================================================================

    async function destroyLoanFixture(loan, customer) {
      const emis = await EmiSchedule.findAll({ where: { loanId: loan.id } });
      await CollectionAllocation.destroy({ where: { emiId: emis.map((e) => e.id) } });
      await Collection.destroy({ where: { loanId: loan.id } });
      await EmiSchedule.destroy({ where: { loanId: loan.id } });
      await LoanParty.destroy({ where: { loanId: loan.id } });
      await loan.destroy();
      await customer.destroy();
    }

    async function makeWeeklyLoan({ name, mobile, startDate, tenure = 5, loanAmount }) {
      let customer;
      let loan;
      await sequelize.transaction(async (transaction) => {
        customer = await customerService.createCustomerRecord({ firstName: name, mobile }, actor, transaction);
        loan = await loanService.createLoanRecord(
          { applicantCustomerId: customer.id, loanAmount, roi: '0', tenure, loanType: 'WEEKLY', startDate, interestMethod: 'FLAT' },
          actor,
          transaction
        );
        await loan.update({ status: LOAN_STATUS.ACTIVE }, { transaction });
      });
      await emiScheduleService.generateSchedule(loan.id, actor);
      return { customer, loan };
    }

    // Loan D: 5 x ₹1,000, WEEKLY from 2026-06-24 -> EMI dates 07-01, 07-08,
    // 07-15, 07-22, 07-29 -- exactly the spec's own example dates.
    const { customer: customerD, loan: loanD } = await makeWeeklyLoan({
      name: 'OneBulk Test D',
      mobile: '9000000005',
      startDate: '2026-06-24',
      loanAmount: '5000'
    });

    // ---------- Test 1 (blank date) — blank date resolves to the system date ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 1000, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd1.xlsx' });
      record(
        'Blank-date Test 1 — a blank Collection Date resolves to the SYSTEM date, not the EMI due date',
        result.imported.length === 1 &&
          result.imported[0].collectionDate === TODAY &&
          result.imported[0].dateSource === 'SYSTEM_DATE' &&
          // EMI 1 is due 2026-07-01; that date must not have been used.
          result.imported[0].collectionDate !== '2026-07-01',
        `collectionDate=${result.imported[0].collectionDate} (today=${TODAY}) source=${result.imported[0].dateSource}`
      );
    }

    // ---------- Test 2 (blank date) — partial payment, still today's date ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 600, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd2.xlsx' });
      const emis = await EmiSchedule.findAll({ where: { loanId: loanD.id }, order: [['emiNumber', 'ASC']] });
      record(
        'Blank-date Test 2 — a partial payment keeps the system date and leaves the instalment PARTIAL',
        result.imported.length === 1 &&
          result.imported[0].collectionDate === TODAY &&
          emis[1].status === EMI_STATUS.PARTIAL &&
          Number(emis[1].amountCollected) === 600 &&
          Number(emis[1].emiAmount) - Number(emis[1].amountCollected) === 400,
        `collectionDate=${result.imported[0].collectionDate} EMI2 status=${emis[1].status} collected=${emis[1].amountCollected}`
      );
    }

    // ---------- Test 3 (blank date) — one row, many EMIs, ONE collection ----------
    {
      // Completes EMI2's remaining 400 (due 07-08), then fully pays EMI3
      // (07-15), EMI4 (07-22) and EMI5 (07-29). Previously four collections,
      // one per instalment date; now a single payment on a single date.
      const buffer = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 3400, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd3.xlsx' });
      const emis = await EmiSchedule.findAll({ where: { loanId: loanD.id }, order: [['emiNumber', 'ASC']] });
      const allPaid = emis.every((emi) => emi.status === EMI_STATUS.PAID);
      const allocations = result.imported[0]?.allocations ?? [];
      const allocatedTotal = allocations.reduce((total, a) => total + Number(a.amount), 0);
      record(
        'Blank-date Test 3 — one row spanning several instalments becomes ONE collection, dated today, allocated across them all',
        result.imported.length === 1 &&
          result.imported[0].collectionDate === TODAY &&
          result.imported[0].dateSource === 'SYSTEM_DATE' &&
          allocations.length === 4 &&
          allocatedTotal === 3400 &&
          allPaid,
        `collections=${result.imported.length} date=${result.imported[0]?.collectionDate} allocations=${allocations.length} total=${allocatedTotal} allPaid=${allPaid}`
      );
    }

    // ---------- Test 4 (blank date) — explicit date always wins ----------
    const { customer: customerG, loan: loanG } = await makeWeeklyLoan({
      name: 'OneBulk Test G',
      mobile: '9000000006',
      startDate: '2026-06-24',
      tenure: 1,
      loanAmount: '1000'
    });
    {
      // EMI1 is due 2026-07-01; an explicit date must be used as-is, not replaced.
      const buffer = await buildWorkbook([row({ loan: loanG.loanNumber, cif: customerG.cifId, amount: 1000, date: '2026-08-20' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd4.xlsx' });
      record(
        'Blank-date Test 4 — an explicit Collection Date is preserved exactly, never replaced by the EMI date',
        result.imported.length === 1 && result.imported[0].collectionDate === '2026-08-20' && result.imported[0].dateSource === 'EXPLICIT',
        JSON.stringify(result.imported)
      );
    }

    // ---------- Tests 5-8 (blank date) — validation still applies with a blank date ----------
    {
      const wrongLoan = await buildWorkbook([row({ loan: 'LN26-999999', cif: customerD.cifId, amount: 100, date: '' })]);
      const previewWrongLoan = await oneBulkImportService.previewImport(wrongLoan, { filename: 'bd5.xlsx' });
      record(
        'Blank-date Test 5 — a wrong loan number is still rejected when the date is blank',
        previewWrongLoan.rows[0].status === 'INVALID' && previewWrongLoan.rows[0].errors.some((e) => e.field === 'loanNumber'),
        JSON.stringify(previewWrongLoan.rows[0].errors)
      );

      const wrongCif = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerG.cifId, amount: 100, date: '' })]);
      const previewWrongCif = await oneBulkImportService.previewImport(wrongCif, { filename: 'bd6.xlsx' });
      record(
        'Blank-date Test 6 — a CIFID not party to the loan is still rejected when the date is blank',
        previewWrongCif.rows[0].status === 'INVALID' && previewWrongCif.rows[0].errors.some((e) => e.field === 'payerCif'),
        JSON.stringify(previewWrongCif.rows[0].errors)
      );

      const badAmount = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 0, date: '' })]);
      const previewBadAmount = await oneBulkImportService.previewImport(badAmount, { filename: 'bd7.xlsx' });
      record(
        'Blank-date Test 7 — an invalid amount is still rejected when the date is blank',
        previewBadAmount.rows[0].status === 'INVALID' && previewBadAmount.rows[0].errors.some((e) => e.field === 'amount'),
        JSON.stringify(previewBadAmount.rows[0].errors)
      );

      const badMode = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 100, date: '', mode: 'UPI' })]);
      const previewBadMode = await oneBulkImportService.previewImport(badMode, { filename: 'bd8.xlsx' });
      record(
        'Blank-date Test 8 — an invalid payment mode is still rejected when the date is blank',
        previewBadMode.rows[0].status === 'INVALID' && previewBadMode.rows[0].errors.some((e) => e.field === 'ledgerType'),
        JSON.stringify(previewBadMode.rows[0].errors)
      );
    }

    // ---------- Test 9 (blank date) — transactional rollback across a multi-collection row ----------
    const { customer: customerH, loan: loanH } = await makeWeeklyLoan({
      name: 'OneBulk Test H',
      mobile: '9000000007',
      startDate: '2026-06-24',
      tenure: 3,
      loanAmount: '3000'
    });
    {
      // One row, blank date, meant to span all 3 EMIs (3 collections). An
      // interloper consumes the whole loan first, so the re-plan inside the
      // transaction finds nothing left -- the whole row, and everything it
      // would have produced, must not be posted at all.
      const buffer = await buildWorkbook([row({ loan: loanH.loanNumber, cif: customerH.cifId, amount: 3000, date: '' })]);

      const allocationService = require('../src/services/collectionAllocationService');
      const { plan: interloperPlan } = await allocationService.planFifoAllocation({ loanId: loanH.id, amount: '3000' });
      const interloper = await collectionService.createCollection(
        {
          loanId: loanH.id,
          customerId: customerH.id,
          amount: '3000',
          collectionDate: '2026-06-20',
          ledgerType: 'CASH',
          allocations: interloperPlan.map((entry) => ({ emiId: entry.emiId, amount: entry.amount }))
        },
        actor,
        context
      );
      createdCollectionIds.push(interloper.collectionNumber);

      let threw = null;
      try {
        await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd9.xlsx' });
      } catch (error) {
        threw = error;
      }

      const collectionsOnLoanH = await Collection.count({ where: { loanId: loanH.id } });
      record(
        'Blank-date Test 9 — a mid-transaction failure rolls back every collection a blank-date row would have produced, not just the failing one',
        threw !== null && collectionsOnLoanH === 1, // only the interloper's collection
        `threw=${threw?.message} collectionsOnLoanH=${collectionsOnLoanH} (expected 1)`
      );
    }

    // =====================================================================
    // Advance EMI payments: a payment settling instalments that are not due
    // yet. The collection date is when the customer paid; the instalment due
    // dates are irrelevant to it, and being in the future never invalidates
    // the row. Fixtures are built relative to TODAY so the dates stay
    // genuinely future whenever this suite is run.
    // =====================================================================

    // EMI n falls on startDate + 7n, so a start six days back puts EMI1 on
    // TODAY + 1 -- the spec's own example, one day out, always future.
    const FUTURE_START = addDays(TODAY, -6);

    // Loan I: 3 x 14,687.50 = 44,062.50, all three instalments still to come.
    const { customer: customerI, loan: loanI } = await makeWeeklyLoan({
      name: 'OneBulk Test I',
      mobile: '9000000008',
      startDate: FUTURE_START,
      tenure: 3,
      loanAmount: '44062.50'
    });

    // ---------- Advance Test 1 (spec 1-4) — one payment, three future EMIs ----------
    {
      const emisBefore = await EmiSchedule.findAll({ where: { loanId: loanI.id }, order: [['emiNumber', 'ASC']] });
      const emiDates = emisBefore.map((emi) => emi.emiDate);
      const buffer = await buildWorkbook([row({ loan: loanI.loanNumber, cif: customerI.cifId, amount: 44062.5, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'adv1.xlsx' });
      const emisAfter = await EmiSchedule.findAll({ where: { loanId: loanI.id }, order: [['emiNumber', 'ASC']] });
      const posted = result.imported[0];
      record(
        'Advance Test 1 (spec 1-4) — a payment for three FUTURE instalments posts as ONE collection dated today, allocated across all three',
        result.imported.length === 1 &&
          posted.collectionDate === TODAY &&
          posted.dateSource === 'SYSTEM_DATE' &&
          // Every instalment is ahead of the payment date, and none of those
          // dates was borrowed as the collection date.
          emiDates.every((due) => due > TODAY) &&
          !emiDates.includes(posted.collectionDate) &&
          posted.allocations.length === 3 &&
          posted.allocations.every((a) => Number(a.amount) === 14687.5) &&
          Number(posted.amount) === 44062.5 &&
          emisAfter.every((emi) => emi.status === EMI_STATUS.PAID),
        `date=${posted?.collectionDate} today=${TODAY} due=${JSON.stringify(emiDates)} allocations=${JSON.stringify(posted?.allocations)}`
      );
    }

    // Loan J: 3 x 1,000, all future -- the part-EMI and skip cases.
    const { customer: customerJ, loan: loanJ } = await makeWeeklyLoan({
      name: 'OneBulk Test J',
      mobile: '9000000009',
      startDate: FUTURE_START,
      tenure: 3,
      loanAmount: '3000'
    });

    // ---------- Advance Test 2 (spec 5) — one full EMI plus part of the next ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanJ.loanNumber, cif: customerJ.cifId, amount: 1500, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'adv2.xlsx' });
      const emis = await EmiSchedule.findAll({ where: { loanId: loanJ.id }, order: [['emiNumber', 'ASC']] });
      const posted = result.imported[0];
      record(
        'Advance Test 2 (spec 5) — 1,500 over future 1,000 instalments fills EMI1 and leaves EMI2 PARTIAL at 500',
        result.imported.length === 1 &&
          posted.collectionDate === TODAY &&
          JSON.stringify(posted.allocations) ===
            JSON.stringify([
              { emiNumber: 1, amount: '1000.00' },
              { emiNumber: 2, amount: '500.00' }
            ]) &&
          emis[0].status === EMI_STATUS.PAID &&
          emis[1].status === EMI_STATUS.PARTIAL &&
          Number(emis[1].amountCollected) === 500 &&
          emis[2].status === EMI_STATUS.PENDING,
        `allocations=${JSON.stringify(posted?.allocations)} statuses=${emis.map((e) => e.status).join(',')}`
      );
    }

    // ---------- Advance Test 3 (spec 8) — fully paid instalments are skipped ----------
    {
      // EMI1 is already PAID and EMI2 has 500 left. The next 1,500 must go to
      // EMI2's remainder and then EMI3 -- EMI1 must not appear at all.
      //
      // The reference is needed only because this is a SECOND 1,500 on the same
      // loan on the same day: without one it is indistinguishable from the
      // payment above, and the existing duplicate check rightly refuses it.
      const buffer = await buildWorkbook([
        row({ loan: loanJ.loanNumber, cif: customerJ.cifId, amount: 1500, date: '', ref: 'ADV3' })
      ]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'adv3.xlsx' });
      const emis = await EmiSchedule.findAll({ where: { loanId: loanJ.id }, order: [['emiNumber', 'ASC']] });
      const posted = result.imported[0];
      record(
        'Advance Test 3 (spec 8) — an already fully paid instalment is skipped; the advance lands on EMI2 remainder and EMI3',
        JSON.stringify(posted.allocations) ===
          JSON.stringify([
            { emiNumber: 2, amount: '500.00' },
            { emiNumber: 3, amount: '1000.00' }
          ]) &&
          // Unchanged, so the earlier payment was not counted twice.
          Number(emis[0].amountCollected) === 1000 &&
          emis.every((emi) => emi.status === EMI_STATUS.PAID),
        `allocations=${JSON.stringify(posted?.allocations)} collected=${emis.map((e) => e.amountCollected).join(',')}`
      );
    }

    // ---------- Advance Test 4 (spec 9) — overpayment still refused ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanJ.loanNumber, cif: customerJ.cifId, amount: 100, date: '' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 'adv4.xlsx' });
      record(
        'Advance Test 4 (spec 9) — paying a loan with nothing left outstanding is still rejected, not banked as an advance',
        preview.rows[0].status === 'INVALID' && preview.rows[0].errors.some((e) => e.field === 'amount'),
        JSON.stringify(preview.rows[0].errors)
      );
    }

    // Loan K: 5 x 1,000 straddling today -- EMIs on TODAY-14, -7, TODAY, +7, +14.
    const { customer: customerK, loan: loanK } = await makeWeeklyLoan({
      name: 'OneBulk Test K',
      mobile: '9000000010',
      startDate: addDays(TODAY, -21),
      tenure: 5,
      loanAmount: '5000'
    });

    // ---------- Advance Test 5 (spec 7) — past-due and future together, in FIFO order ----------
    {
      const emisBefore = await EmiSchedule.findAll({ where: { loanId: loanK.id }, order: [['emiNumber', 'ASC']] });
      const straddles = emisBefore.some((e) => e.emiDate < TODAY) && emisBefore.some((e) => e.emiDate > TODAY);
      const buffer = await buildWorkbook([row({ loan: loanK.loanNumber, cif: customerK.cifId, amount: 5000, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'adv5.xlsx' });
      const posted = result.imported[0];
      record(
        'Advance Test 5 (spec 7) — a payment covering overdue AND future instalments follows the existing FIFO order, oldest first',
        straddles &&
          result.imported.length === 1 &&
          posted.collectionDate === TODAY &&
          JSON.stringify(posted.allocations.map((a) => a.emiNumber)) === JSON.stringify([1, 2, 3, 4, 5]),
        `straddles=${straddles} order=${JSON.stringify(posted?.allocations.map((a) => a.emiNumber))}`
      );
    }

    // Loan L: 3 x 1,000, all future -- the partial, preview and validation cases.
    const { customer: customerL, loan: loanL } = await makeWeeklyLoan({
      name: 'OneBulk Test L',
      mobile: '9000000011',
      startDate: FUTURE_START,
      tenure: 3,
      loanAmount: '3000'
    });

    // ---------- Advance Test 6 (spec 11) — the reported bug ----------
    {
      // This is the row from the reported error: a blank date on a loan whose
      // every instalment is still ahead. It must simply be valid.
      const buffer = await buildWorkbook([row({ loan: loanL.loanNumber, cif: customerL.cifId, amount: 3000, date: '' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 'adv6.xlsx' });
      const previewRow = preview.rows[0];
      record(
        'Advance Test 6 (spec 11) — a blank date never becomes an invalid FUTURE collection date because the instalments are future',
        previewRow.status === 'VALID' &&
          previewRow.errors.length === 0 &&
          previewRow.dateGroups.length === 1 &&
          previewRow.dateGroups[0].date === TODAY &&
          previewRow.dateGroups[0].source === 'SYSTEM_DATE' &&
          previewRow.dateGroups[0].allocations.length === 3,
        `status=${previewRow.status} errors=${JSON.stringify(previewRow.errors)} groups=${JSON.stringify(previewRow.dateGroups)}`
      );
    }

    // ---------- Advance Test 7 (spec 10) — an invalid ACTUAL date is still refused ----------
    {
      const buffer = await buildWorkbook([
        row({ loan: loanL.loanNumber, cif: customerL.cifId, amount: 1000, date: addDays(TODAY, 1) })
      ]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 'adv7.xlsx' });
      record(
        'Advance Test 7 (spec 10) — a collection date the operator actually typed in the future is still rejected',
        preview.rows[0].status === 'INVALID' && preview.rows[0].errors.some((e) => e.field === 'collectionDate'),
        JSON.stringify(preview.rows[0].errors)
      );
    }

    // ---------- Advance Test 8 (spec 6) — a payment smaller than one instalment ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanL.loanNumber, cif: customerL.cifId, amount: 400, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'adv8.xlsx' });
      const emis = await EmiSchedule.findAll({ where: { loanId: loanL.id }, order: [['emiNumber', 'ASC']] });
      record(
        'Advance Test 8 (spec 6) — less than one future instalment is a valid partial payment, dated today',
        result.imported.length === 1 &&
          result.imported[0].collectionDate === TODAY &&
          result.imported[0].allocations.length === 1 &&
          emis[0].status === EMI_STATUS.PARTIAL &&
          Number(emis[0].amountCollected) === 400,
        `date=${result.imported[0]?.collectionDate} EMI1=${emis[0].status}/${emis[0].amountCollected}`
      );
    }

    // ---------- Advance Test 9 (spec 12) — preview writes nothing ----------
    {
      const snapshot = async () => ({
        collections: await Collection.count(),
        allocations: await CollectionAllocation.count(),
        emi1: Number((await EmiSchedule.findOne({ where: { loanId: loanL.id, emiNumber: 1 } })).amountCollected)
      });
      const before = await snapshot();
      const buffer = await buildWorkbook([row({ loan: loanL.loanNumber, cif: customerL.cifId, amount: 2600, date: '' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 'adv9.xlsx' });
      const after = await snapshot();
      record(
        'Advance Test 9 (spec 12) — previewing an advance payment writes nothing: no collection, no allocation, no EMI change',
        preview.summary.previewOnly === true &&
          preview.rows[0].status === 'VALID' &&
          before.collections === after.collections &&
          before.allocations === after.allocations &&
          before.emi1 === after.emi1,
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`
      );
    }

    // ---------- Advance Test 10 (spec 13) — confirmation re-plans from the database ----------
    const { customer: customerM, loan: loanM } = await makeWeeklyLoan({
      name: 'OneBulk Test M',
      mobile: '9000000012',
      startDate: FUTURE_START,
      tenure: 2,
      loanAmount: '2000'
    });
    {
      // The file previews as a valid advance payment for the whole loan. Between
      // preview and confirmation someone posts 1,500 by hand. If confirmation
      // trusted the preview's allocations it would post 2,000 against a loan
      // with 500 left; instead it re-plans from the ledger and refuses the row.
      const buffer = await buildWorkbook([row({ loan: loanM.loanNumber, cif: customerM.cifId, amount: 2000, date: '' })]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 'adv10.xlsx' });
      const previewedValid = preview.rows[0].status === 'VALID';

      const allocationService = require('../src/services/collectionAllocationService');
      const { plan: interloperPlan } = await allocationService.planFifoAllocation({ loanId: loanM.id, amount: '1500' });
      const interloper = await collectionService.createCollection(
        {
          loanId: loanM.id,
          customerId: customerM.id,
          amount: '1500',
          collectionDate: TODAY,
          ledgerType: 'CASH',
          allocations: interloperPlan.map((entry) => ({ emiId: entry.emiId, amount: entry.amount }))
        },
        actor,
        context
      );
      createdCollectionIds.push(interloper.collectionNumber);

      let threw = null;
      try {
        await oneBulkImportService.runImport(buffer, actor, context, { filename: 'adv10.xlsx' });
      } catch (error) {
        threw = error;
      }
      const collectionsOnM = await Collection.count({ where: { loanId: loanM.id } });
      record(
        'Advance Test 10 (spec 13) — confirmation recalculates allocations from current DB state and never trusts the preview',
        previewedValid && threw !== null && collectionsOnM === 1,
        `previewedValid=${previewedValid} threw=${threw?.message} collectionsOnLoanM=${collectionsOnM} (expected 1)`
      );
    }

    // ---------- Advance Test 11 (spec 14) — a failure rolls back the WHOLE import ----------
    const { customer: customerN, loan: loanN } = await makeWeeklyLoan({
      name: 'OneBulk Test N',
      mobile: '9000000013',
      startDate: FUTURE_START,
      tenure: 2,
      loanAmount: '2000'
    });
    const { customer: customerP, loan: loanP } = await makeWeeklyLoan({
      name: 'OneBulk Test P',
      mobile: '9000000014',
      startDate: FUTURE_START,
      tenure: 2,
      loanAmount: '2000'
    });
    {
      // Two advance rows, two loans. Loan P is emptied by hand first, so its row
      // cannot be allocated once the import reaches it. Loan N's row is
      // perfectly good and is processed first -- and must still leave no trace.
      const allocationService = require('../src/services/collectionAllocationService');
      const { plan: interloperPlan } = await allocationService.planFifoAllocation({ loanId: loanP.id, amount: '2000' });
      const interloper = await collectionService.createCollection(
        {
          loanId: loanP.id,
          customerId: customerP.id,
          amount: '2000',
          collectionDate: TODAY,
          ledgerType: 'CASH',
          allocations: interloperPlan.map((entry) => ({ emiId: entry.emiId, amount: entry.amount }))
        },
        actor,
        context
      );
      createdCollectionIds.push(interloper.collectionNumber);

      const buffer = await buildWorkbook([
        row({ loan: loanN.loanNumber, cif: customerN.cifId, amount: 2000, date: '', ref: 'ADV11-N' }),
        // Its own reference, so this row fails on the ALLOCATION inside the
        // transaction rather than being caught as a duplicate of the hand-posted
        // payment before the transaction even opens.
        row({ loan: loanP.loanNumber, cif: customerP.cifId, amount: 2000, date: '', ref: 'ADV11-P' })
      ]);

      let threw = null;
      try {
        await oneBulkImportService.runImport(buffer, actor, context, { filename: 'adv11.xlsx' });
      } catch (error) {
        threw = error;
      }
      const collectionsOnN = await Collection.count({ where: { loanId: loanN.id } });
      const emisN = await EmiSchedule.findAll({ where: { loanId: loanN.id } });
      record(
        'Advance Test 11 (spec 14) — one unallocatable row rolls the entire import back, including the valid advance payment before it',
        threw !== null && collectionsOnN === 0 && emisN.every((emi) => Number(emi.amountCollected) === 0),
        `threw=${threw?.message} collectionsOnLoanN=${collectionsOnN} collected=${emisN.map((e) => e.amountCollected).join(',')}`
      );
    }

    await destroyLoanFixture(loanI, customerI);
    await destroyLoanFixture(loanJ, customerJ);
    await destroyLoanFixture(loanK, customerK);
    await destroyLoanFixture(loanL, customerL);
    await destroyLoanFixture(loanM, customerM);
    await destroyLoanFixture(loanN, customerN);
    await destroyLoanFixture(loanP, customerP);

    // =====================================================================
    // Large allocations and a whole-workbook import.
    //
    // One payment can settle every remaining instalment of a long daily loan,
    // which is more than the request-shape limit of 100 allows for a
    // client-supplied allocation array. These pin that a SERVER-PLANNED list
    // is not bound by that limit, that it is still bound by something, and
    // that a whole file's worth of rows goes in as one import.
    // =====================================================================

    async function makeDailyLoan({ name, mobile, startDate, tenure, loanAmount }) {
      let customer;
      let loan;
      await sequelize.transaction(async (transaction) => {
        customer = await customerService.createCustomerRecord({ firstName: name, mobile }, actor, transaction);
        loan = await loanService.createLoanRecord(
          { applicantCustomerId: customer.id, loanAmount, roi: '0', tenure, loanType: 'DAILY', interestMethod: 'FLAT', startDate },
          actor,
          transaction
        );
        await loan.update({ status: LOAN_STATUS.ACTIVE }, { transaction });
      });
      await emiScheduleService.generateSchedule(loan.id, actor);
      return { customer, loan };
    }

    // Loan Q: 150 daily instalments of 100.00 -- comfortably past 100.
    const { customer: customerQ, loan: loanQ } = await makeDailyLoan({
      name: 'OneBulk Test Q',
      mobile: '9000000015',
      startDate: addDays(TODAY, -30),
      tenure: 150,
      loanAmount: '15000'
    });

    // ---------- Bulk Test 1 (spec 1) — 101 instalments in one collection ----------
    {
      // 101 x 100.00. The 100-instalment request-shape limit would have refused
      // this outright; a planned list is measured against the planned ceiling.
      const emisQ = await EmiSchedule.findAll({ where: { loanId: loanQ.id } });
      const buffer = await buildWorkbook([
        row({ loan: loanQ.loanNumber, cif: customerQ.cifId, amount: 10100, date: '', ref: 'BULK1' })
      ]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bulk1.xlsx' });
      const posted = result.imported[0];
      const allocated = await CollectionAllocation.count({ where: { emiId: emisQ.map((e) => e.id) } });
      record(
        'Bulk Test 1 (spec 1) — a payment settling 101 instalments posts as ONE collection with 101 allocations',
        emisQ.length === 150 &&
          result.imported.length === 1 &&
          posted.allocations.length === 101 &&
          allocated === 101 &&
          Number(posted.amount) === 10100 &&
          posted.allocations.reduce((total, a) => total + Number(a.amount), 0) === 10100,
        `emis=${emisQ.length} collections=${result.imported.length} allocations=${posted?.allocations.length} rowsWritten=${allocated}`
      );
    }

    // ---------- Bulk Test 2 (spec 6) — a partial final instalment ----------
    {
      // 49 instalments remain at 100.00 each. Pay 4,050: 40 full instalments
      // and half of the 41st.
      const buffer = await buildWorkbook([
        row({ loan: loanQ.loanNumber, cif: customerQ.cifId, amount: 4050, date: '', ref: 'BULK2' })
      ]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bulk2.xlsx' });
      const posted = result.imported[0];
      const last = posted.allocations[posted.allocations.length - 1];
      const emis = await EmiSchedule.findAll({ where: { loanId: loanQ.id }, order: [['emiNumber', 'ASC']] });
      record(
        'Bulk Test 2 (spec 6) — a large payment ending mid-instalment allocates the remainder as a partial payment',
        posted.allocations.length === 41 &&
          Number(last.amount) === 50 &&
          last.emiNumber === 142 &&
          emis[141].status === EMI_STATUS.PARTIAL &&
          Number(emis[141].amountCollected) === 50 &&
          emis.slice(0, 141).every((emi) => emi.status === EMI_STATUS.PAID),
        `allocations=${posted?.allocations.length} last=EMI#${last?.emiNumber}/${last?.amount} status=${emis[141]?.status}`
      );
    }

    // ---------- Bulk Test 3 (spec 5) — more than the loan still owes ----------
    {
      // 8 instalments x 100.00 = 800.00 left. 900.00 must be refused, not
      // part-allocated and not banked.
      const buffer = await buildWorkbook([
        row({ loan: loanQ.loanNumber, cif: customerQ.cifId, amount: 900, date: '', ref: 'BULK3' })
      ]);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 'bulk3.xlsx' });
      const before = await Collection.count({ where: { loanId: loanQ.id } });
      let threw = null;
      try {
        await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bulk3.xlsx' });
      } catch (error) {
        threw = error;
      }
      const after = await Collection.count({ where: { loanId: loanQ.id } });
      record(
        'Bulk Test 3 (spec 5) — a payment above the loan’s remaining outstanding is refused on a long schedule too',
        preview.rows[0].status === 'INVALID' &&
          preview.rows[0].errors.some((e) => e.field === 'amount' && /cannot be allocated/.test(e.reason)) &&
          preview.summary.invalidRows === 1 &&
          preview.summary.validRows === 0 &&
          threw !== null &&
          before === after,
        `status=${preview.rows[0].status} invalidRows=${preview.summary.invalidRows} collections ${before}->${after}`
      );
    }

    // ---------- Bulk Test 4 (spec 2) — the ceiling, and where it comes from ----------
    {
      const { MAX_ALLOCATIONS_PER_COLLECTION, MAX_PLANNED_ALLOCATIONS_PER_COLLECTION } = require('../src/config/collections');
      const { TENURE_MAX, COLLECTION_COUNT_MAX } = require('../src/config/loans');
      const allocationService = require('../src/services/collectionAllocationService');

      // A synthetic list, because no loan the system can create has more
      // instalments than the ceiling -- which is the point of deriving it from
      // TENURE_MAX rather than picking a number.
      const synthetic = (count) =>
        Array.from({ length: count }, (_, index) => ({ emiId: index + 1, amount: '1.00' }));

      const atCeiling = (() => {
        try {
          allocationService.assertAllocationShape(synthetic(MAX_PLANNED_ALLOCATIONS_PER_COLLECTION), {
            maxAllocations: MAX_PLANNED_ALLOCATIONS_PER_COLLECTION
          });
          return null;
        } catch (error) {
          return error.message;
        }
      })();

      const overCeiling = (() => {
        try {
          allocationService.assertAllocationShape(synthetic(MAX_PLANNED_ALLOCATIONS_PER_COLLECTION + 1), {
            maxAllocations: MAX_PLANNED_ALLOCATIONS_PER_COLLECTION
          });
          return null;
        } catch (error) {
          return error.message;
        }
      })();

      const clientOver100 = (() => {
        try {
          allocationService.assertAllocationShape(synthetic(101));
          return null;
        } catch (error) {
          return error.message;
        }
      })();

      record(
        'Bulk Test 4 (spec 2, 11) — the planned ceiling is TENURE_MAX, it is enforced, and the client limit is untouched at 100',
        MAX_PLANNED_ALLOCATIONS_PER_COLLECTION === TENURE_MAX &&
          COLLECTION_COUNT_MAX === TENURE_MAX &&
          MAX_ALLOCATIONS_PER_COLLECTION === 100 &&
          atCeiling === null &&
          /cannot allocate to more than 3650 instalments/.test(overCeiling ?? '') &&
          // The default is still the request-shape limit, so nothing a caller
          // supplies got looser.
          /cannot allocate to more than 100 instalments/.test(clientOver100 ?? ''),
        `planned=${MAX_PLANNED_ALLOCATIONS_PER_COLLECTION} tenureMax=${TENURE_MAX} client=${MAX_ALLOCATIONS_PER_COLLECTION} atCeiling=${atCeiling} over=${overCeiling} client101=${clientOver100}`
      );
    }

    await destroyLoanFixture(loanQ, customerQ);

    // ---------- Bulk Test 5 (spec 3, 4, 8) — one file, 190 rows ----------
    const bulkFixtures = [];
    {
      // Ten weekly loans of 19 instalments, one row per instalment: 190 rows in
      // a single workbook, ten rows per loan, deliberately shuffled so the FIFO
      // and date ordering has to do real work.
      for (let index = 0; index < 10; index += 1) {
        bulkFixtures.push(
          // eslint-disable-next-line no-await-in-loop
          await makeWeeklyLoan({
            name: `OneBulk Test R${index}`,
            mobile: `90000001${String(20 + index).padStart(2, '0')}`,
            startDate: addDays(TODAY, -140),
            tenure: 19,
            loanAmount: '1900'
          })
        );
      }

      const sheetRows = [];
      for (const { customer, loan } of bulkFixtures) {
        for (let n = 1; n <= 19; n += 1) {
          sheetRows.push(row({ loan: loan.loanNumber, cif: customer.cifId, amount: 100, date: '', ref: `R${loan.loanNumber}-${n}` }));
        }
      }
      // Shuffle deterministically: interleave the loans rather than grouping them.
      const interleaved = [];
      for (let n = 0; n < 19; n += 1) {
        for (let l = 0; l < 10; l += 1) interleaved.push(sheetRows[l * 19 + n]);
      }

      const buffer = await buildWorkbook(interleaved);
      const preview = await oneBulkImportService.previewImport(buffer, { filename: 'bulk190.xlsx' });

      const countsAgree =
        preview.summary.totalRows === preview.rows.length &&
        preview.summary.validRows === preview.rows.filter((r) => r.status === 'VALID').length &&
        preview.summary.invalidRows === preview.rows.filter((r) => r.status === 'INVALID').length &&
        preview.summary.duplicateRows === preview.rows.filter((r) => r.status === 'DUPLICATE').length &&
        preview.summary.validRows + preview.summary.invalidRows + preview.summary.duplicateRows === preview.summary.totalRows;

      record(
        'Bulk Test 5 (spec 3, 8) — a 190-row workbook previews as 190 valid rows, and every summary count matches the rows themselves',
        interleaved.length === 190 &&
          preview.summary.totalRows === 190 &&
          preview.summary.validRows === 190 &&
          preview.summary.invalidRows === 0 &&
          preview.summary.previewOnly === true &&
          countsAgree,
        `total=${preview.summary.totalRows} valid=${preview.summary.validRows} invalid=${preview.summary.invalidRows} countsAgree=${countsAgree}`
      );

      // ---------- Bulk Test 6 (spec 7) — one bad row, nothing posted ----------
      const withBadRow = await buildWorkbook([
        ...interleaved,
        row({ loan: 'LN26-999999', cif: bulkFixtures[0].customer.cifId, amount: 100, date: '', ref: 'BADROW' })
      ]);
      const badPreview = await oneBulkImportService.previewImport(withBadRow, { filename: 'bulk191.xlsx' });
      let badThrew = null;
      try {
        await oneBulkImportService.runImport(withBadRow, actor, context, { filename: 'bulk191.xlsx' });
      } catch (error) {
        badThrew = error;
      }
      const postedAfterBad = await Collection.count({
        where: { loanId: bulkFixtures.map(({ loan }) => loan.id) }
      });
      record(
        'Bulk Test 6 (spec 7) — one invalid row in a 191-row file posts nothing at all, and the summary counts it invalid',
        badPreview.summary.totalRows === 191 &&
          badPreview.summary.validRows === 190 &&
          badPreview.summary.invalidRows === 1 &&
          badThrew !== null &&
          /unusable row/.test(badThrew.message) &&
          postedAfterBad === 0,
        `total=${badPreview.summary.totalRows} valid=${badPreview.summary.validRows} invalid=${badPreview.summary.invalidRows} posted=${postedAfterBad} threw=${badThrew?.message}`
      );

      // ---------- Bulk Test 7 (spec 3, 4) — post all 190 in one confirmation ----------
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bulk190.xlsx' });
      const totalPosted = result.imported.reduce((total, entry) => total + Number(entry.amount), 0);
      const allocationRows = await CollectionAllocation.count({
        include: [{ association: 'Collection', where: { loanId: bulkFixtures.map(({ loan }) => loan.id) }, required: true }]
      });

      // FIFO per loan: the rows for one loan, in the order they were posted,
      // must have taken instalments 1..19 in order and nothing twice.
      let fifoHolds = true;
      for (const { loan } of bulkFixtures) {
        // eslint-disable-next-line no-await-in-loop
        const emis = await EmiSchedule.findAll({ where: { loanId: loan.id }, order: [['emiNumber', 'ASC']] });
        if (emis.length !== 19) fifoHolds = false;
        if (!emis.every((emi) => emi.status === EMI_STATUS.PAID && Number(emi.amountCollected) === 100)) fifoHolds = false;
      }
      const perLoan = result.imported.filter((entry) => entry.allocations.length === 1).length;

      record(
        'Bulk Test 7 (spec 3, 4) — all 190 rows post in one confirmation, each allocating to the next unpaid instalment in FIFO order',
        result.imported.length === 190 &&
          totalPosted === 19000 &&
          Number(result.summary.importedAmount) === 19000 &&
          allocationRows === 190 &&
          perLoan === 190 &&
          fifoHolds &&
          result.reconciliation.collectionAmountEqualsAllocationTotal === true &&
          result.reconciliation.loansAffected === 10 &&
          result.reconciliation.emisAffected === 190 &&
          result.reconciliation.fullyPaidEmis === 190,
        `collections=${result.imported.length} amount=${totalPosted} allocationRows=${allocationRows} fifo=${fifoHolds} reconciliation=${JSON.stringify(result.reconciliation)}`
      );
    }

    for (const { customer, loan } of bulkFixtures) {
      await destroyLoanFixture(loan, customer);
    }


    await destroyLoanFixture(loanD, customerD);
    await destroyLoanFixture(loanG, customerG);
    await destroyLoanFixture(loanH, customerH);
  } catch (fatal) {
    record('FATAL — the test run itself threw', false, fatal.stack || fatal.message);
  } finally {
    // ---------- cleanup: delete everything this run created ----------
    try {
      if (loanA) {
        const emisA = await EmiSchedule.findAll({ where: { loanId: loanA.id } });
        await CollectionAllocation.destroy({ where: { emiId: emisA.map((e) => e.id) } });
        await Collection.destroy({ where: { loanId: loanA.id } });
        await EmiSchedule.destroy({ where: { loanId: loanA.id } });
        await LoanParty.destroy({ where: { loanId: loanA.id } });
        await loanA.destroy();
      }
      if (loanB) {
        const emisB = await EmiSchedule.findAll({ where: { loanId: loanB.id } });
        await CollectionAllocation.destroy({ where: { emiId: emisB.map((e) => e.id) } });
        await Collection.destroy({ where: { loanId: loanB.id } });
        await EmiSchedule.destroy({ where: { loanId: loanB.id } });
        await LoanParty.destroy({ where: { loanId: loanB.id } });
        await loanB.destroy();
      }
      if (customerA) await customerA.destroy();
      if (customerB) await customerB.destroy();
    } catch (cleanupError) {
      record('Cleanup', false, cleanupError.stack || cleanupError.message);
    }
  }

  console.log('\n=== oneBulk test results ===\n');
  let failed = 0;
  for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
    if (!result.pass || process.env.VERBOSE) console.log(`      ${result.detail}`);
    if (!result.pass) failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} passed\n`);

  await sequelize.close();
  process.exit(failed ? 1 : 0);
})();
