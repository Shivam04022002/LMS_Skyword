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
    // Blank Collection Date: derive the payment date from the EMI(s) it pays
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

    // ---------- Test 1 (blank date) — blank date, one EMI ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 1000, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd1.xlsx' });
      record(
        'Blank-date Test 1 — a blank date, one EMI, derives the collection date from that EMI\'s due date',
        result.imported.length === 1 &&
          result.imported[0].collectionDate === '2026-07-01' &&
          result.imported[0].dateSource === 'AUTO_EMI_DATE',
        JSON.stringify(result.imported)
      );
    }

    // ---------- Test 2 (blank date) — blank date, partial EMI ----------
    {
      const buffer = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 600, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd2.xlsx' });
      const emis = await EmiSchedule.findAll({ where: { loanId: loanD.id }, order: [['emiNumber', 'ASC']] });
      record(
        'Blank-date Test 2 — a blank date, partial EMI, still derives the EMI due date and leaves it PARTIAL',
        result.imported.length === 1 &&
          result.imported[0].collectionDate === '2026-07-08' &&
          emis[1].status === EMI_STATUS.PARTIAL &&
          Number(emis[1].amountCollected) === 600 &&
          Number(emis[1].emiAmount) - Number(emis[1].amountCollected) === 400,
        `collectionDate=${result.imported[0].collectionDate} EMI2 status=${emis[1].status} collected=${emis[1].amountCollected}`
      );
    }

    // ---------- Test 3 (blank date) — one row spanning multiple EMIs on different dates ----------
    {
      // Completes EMI2's remaining 400 (due 07-08), then fully pays EMI3
      // (07-15), EMI4 (07-22) and EMI5 (07-29) -- one row, four collections.
      const buffer = await buildWorkbook([row({ loan: loanD.loanNumber, cif: customerD.cifId, amount: 3400, date: '' })]);
      const result = await oneBulkImportService.runImport(buffer, actor, context, { filename: 'bd3.xlsx' });
      const dates = result.imported.map((c) => c.collectionDate).sort();
      const emis = await EmiSchedule.findAll({ where: { loanId: loanD.id }, order: [['emiNumber', 'ASC']] });
      const allPaid = emis.every((emi) => emi.status === EMI_STATUS.PAID);
      const allAuto = result.imported.every((c) => c.dateSource === 'AUTO_EMI_DATE');
      record(
        'Blank-date Test 3 — one row spanning several EMIs on different dates becomes one collection per EMI date, never the last EMI\'s date for the whole amount',
        result.imported.length === 4 &&
          JSON.stringify(dates) === JSON.stringify(['2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29']) &&
          allPaid &&
          allAuto,
        `dates=${JSON.stringify(dates)} allPaid=${allPaid}`
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
