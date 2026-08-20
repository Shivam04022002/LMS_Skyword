'use strict';

/**
 * Report module constants.
 *
 * Phase 9 adds NO tables. Every report is a derived query over the existing
 * source-of-truth chain (customer → loan → emi_schedule → collection →
 * collection_allocation), and the receipt is a read-only view of one posted
 * collection.
 */
const REPORTS = Object.freeze({
  LOANS: 'loans',
  COLLECTIONS: 'collections',
  EMIS: 'emis',
  DEMAND_COLLECTIONS: 'demand-collections'
});

const REPORT_VALUES = Object.values(REPORTS);

/** Export formats the API can serve. */
const EXPORT_FORMATS = Object.freeze({ CSV: 'csv', XLSX: 'xlsx' });

const EXPORT_FORMAT_VALUES = Object.values(EXPORT_FORMATS);

/**
 * What the workbook's Summary sheet shows, per report. Every value is read from
 * the report's own summary block — the same numbers the screen displays — so an
 * exported total can never be computed a second way.
 */
const SUMMARY_FIELDS = Object.freeze({
  [REPORTS.LOANS]: [
    { label: 'Total Loans', path: 'loanCount', type: 'number' },
    { label: 'Loan Amount', path: 'totalLoanAmount', type: 'money' },
    { label: 'Total Repayment', path: 'totalRepayment', type: 'money' },
    { label: 'Collected', path: 'totalCollected', type: 'money' },
    { label: 'Outstanding', path: 'totalOutstanding', type: 'money' }
  ],
  [REPORTS.COLLECTIONS]: [
    { label: 'Total Collections', path: 'totalCount', type: 'number' },
    { label: 'Posted', path: 'postedCount', type: 'number' },
    { label: 'Posted Amount', path: 'postedAmount', type: 'money' },
    { label: 'Reversed', path: 'reversedCount', type: 'number' },
    { label: 'Reversed Amount', path: 'reversedAmount', type: 'money' },
    { label: 'Net Collected', path: 'netCollected', type: 'money' },
    { label: 'Collected Principal', path: 'collectedPrincipal', type: 'money' },
    { label: 'Collected Interest', path: 'collectedInterest', type: 'money' },
    { label: 'Collected Bounce', path: 'collectedBounce', type: 'money' }
  ],
  [REPORTS.EMIS]: [
    { label: 'As Of', path: 'asOf' },
    { label: 'Instalments', path: 'emiCount', type: 'number' },
    { label: 'EMI Value', path: 'totalEmiAmount', type: 'money' },
    { label: 'Principal', path: 'totalPrincipal', type: 'money' },
    { label: 'Interest', path: 'totalInterest', type: 'money' },
    { label: 'Collected', path: 'totalCollected', type: 'money' },
    { label: 'Outstanding', path: 'totalOutstanding', type: 'money' }
  ],
  [REPORTS.DEMAND_COLLECTIONS]: [
    { label: 'As Of', path: 'asOf' },
    { label: 'Routes', path: 'routeCount', type: 'number' },
    { label: 'Demand EMIs', path: 'demandEmiCount', type: 'number' },
    { label: 'Gross Demand', path: 'grossDemand', type: 'money' },
    { label: 'Already Collected', path: 'collectedAgainstDemand', type: 'money' },
    { label: 'Net Demand Outstanding', path: 'netDemand', type: 'money' },
    { label: 'Collections In Period', path: 'collectionCount', type: 'number' },
    { label: 'Collected In Period', path: 'collectedInPeriod', type: 'money' }
  ]
});

/** Human titles for the workbook and its sheets. */
const REPORT_TITLES = Object.freeze({
  [REPORTS.LOANS]: 'Loan Report',
  [REPORTS.COLLECTIONS]: 'Collection Report',
  [REPORTS.EMIS]: 'EMI Report',
  [REPORTS.DEMAND_COLLECTIONS]: 'Demand vs Collection Report'
});

/**
 * Ceiling on an export so a single request cannot pull an unbounded result set
 * into memory. Exceeding it is an explicit error rather than a silent trim.
 */
const EXPORT_MAX_ROWS = 10000;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/**
 * Marks a service call as serving a download rather than a screen.
 *
 * A Symbol, deliberately: it cannot arrive from a query string, so a caller
 * cannot ask an on-screen page for an export-sized result set. Only the report
 * controller sets it, and only on the export path, which already requires the
 * reports.export permission.
 */
const EXPORT_SCOPE = Symbol('report.export');

/**
 * CSV column definitions per report.
 *
 * These are the only fields an export may contain — the shape is declared here
 * rather than derived from the row object, so an internal field can never leak
 * into a downloaded file by accident. Note the absence of any user id, password,
 * token or internal foreign key.
 */
const CSV_COLUMNS = Object.freeze({
  [REPORTS.LOANS]: [
    { header: 'Loan Number', path: 'loanNumber', type: 'code' },
    { header: 'Status', path: 'status' },
    { header: 'Applicant', path: 'customer.fullName' },
    { header: 'CIF', path: 'customer.cifId', type: 'code' },
    { header: 'Mobile', path: 'customer.mobile', type: 'code' },
    { header: 'Loan Amount', path: 'loanAmount', type: 'money' },
    { header: 'ROI %', path: 'roi', type: 'number' },
    { header: 'ROI basis', path: 'roiBasis' },
    { header: 'Tenure', path: 'tenure', type: 'number' },
    { header: 'Loan Type', path: 'loanType' },
    { header: 'Total Repayment', path: 'totalRepayment', type: 'money' },
    { header: 'EMI Amount', path: 'emiAmount', type: 'money' },
    { header: 'EMI Count', path: 'emiCount', type: 'number' },
    { header: 'Collected', path: 'collected', type: 'money' },
    { header: 'Outstanding', path: 'outstanding', type: 'money' },
    { header: 'Route Code', path: 'route.routeCode', type: 'code' },
    { header: 'Route Name', path: 'route.name' },
    { header: 'Collectors', path: 'collectorNames' },
    { header: 'Start Date', path: 'startDate', type: 'date' },
    { header: 'Created Date', path: 'createdAt', type: 'date' }
  ],
  [REPORTS.COLLECTIONS]: [
    { header: 'Collection Number', path: 'collectionNumber', type: 'code' },
    { header: 'Collection Date', path: 'collectionDate', type: 'date' },
    { header: 'Status', path: 'status' },
    { header: 'Loan Number', path: 'loan.loanNumber', type: 'code' },
    { header: 'Applicant', path: 'customer.fullName' },
    { header: 'CIF', path: 'customer.cifId', type: 'code' },
    { header: 'Amount', path: 'amount', type: 'money' },
    { header: 'Collected Principal', path: 'collectedPrincipal', type: 'money' },
    { header: 'Collected Interest', path: 'collectedInterest', type: 'money' },
    { header: 'Collected Bounce', path: 'collectedBounce', type: 'money' },
    { header: 'Ledger', path: 'ledgerType' },
    { header: 'Payment Reference', path: 'paymentReference', type: 'code' },
    { header: 'Route Code', path: 'route.routeCode', type: 'code' },
    { header: 'Collected By', path: 'createdBy' },
    { header: 'Counts Toward Totals', path: 'countsTowardTotals' }
  ],
  [REPORTS.EMIS]: [
    { header: 'Loan Number', path: 'loan.loanNumber', type: 'code' },
    { header: 'Applicant', path: 'customer.fullName' },
    { header: 'CIF', path: 'customer.cifId', type: 'code' },
    { header: 'EMI Number', path: 'emiNumber', type: 'number' },
    { header: 'Due Date', path: 'emiDate', type: 'date' },
    { header: 'EMI Amount', path: 'emiAmount', type: 'money' },
    { header: 'Principal', path: 'principal', type: 'money' },
    { header: 'Interest', path: 'interest', type: 'money' },
    { header: 'Bounce Charge', path: 'bounceCharge', type: 'money' },
    { header: 'Collected', path: 'amountCollected', type: 'money' },
    { header: 'Outstanding', path: 'outstanding', type: 'money' },
    { header: 'DPD', path: 'dpd', type: 'number' },
    { header: 'Status', path: 'status' },
    { header: 'Route Code', path: 'route.routeCode', type: 'code' },
    { header: 'Collectors', path: 'collectorNames' }
  ],
  [REPORTS.DEMAND_COLLECTIONS]: [
    { header: 'Route Code', path: 'route.routeCode', type: 'code' },
    { header: 'Route Name', path: 'route.name' },
    { header: 'Collectors', path: 'collectorNames' },
    { header: 'Demand EMIs', path: 'demandEmiCount', type: 'number' },
    { header: 'Gross Demand', path: 'grossDemand', type: 'money' },
    { header: 'Already Collected', path: 'collectedAgainstDemand', type: 'money' },
    { header: 'Net Demand Outstanding', path: 'netDemand', type: 'money' },
    { header: 'Collections In Period', path: 'collectionCount', type: 'number' },
    { header: 'Collected In Period', path: 'collectedInPeriod', type: 'money' }
  ]
});

module.exports = {
  REPORTS,
  REPORT_VALUES,
  EXPORT_FORMATS,
  EXPORT_FORMAT_VALUES,
  SUMMARY_FIELDS,
  REPORT_TITLES,
  EXPORT_MAX_ROWS,
  EXPORT_SCOPE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  CSV_COLUMNS
};
