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
  DEMAND_COLLECTIONS: 'demand-collections',
  /*
   * Bounce collection — the same collection rows as REPORTS.COLLECTIONS, with
   * `bounce_amount > 0` applied in SQL. It is a distinct report key rather than
   * a filter on the collection report because it needs its own title, its own
   * export columns and its own Summary sheet; the DATA still comes from the one
   * collection query, so there is no second bounce calculation anywhere.
   */
  BOUNCE_COLLECTIONS: 'bounce-collections',
  /*
   * Graph & Analytics — the SAME figures the five reports above produce, grouped
   * into chart series instead of listed as rows. It is a report key so it
   * inherits the one report pipeline: reports.view to read, reports.export to
   * download, the export audit entry, the row ceiling and the workbook builder.
   *
   * It computes nothing of its own. Loan, collection, instalment and bounce
   * figures come from the same columns and the same helpers the other reports
   * read, and demand reuses the instalment rules rather than restating them, so
   * an analytics total and a report total for identical filters are the same
   * number by construction.
   */
  ANALYTICS: 'analytics'
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
    // Money ACTUALLY received against bounce charges, not the charges assessed.
    // Net Collected = EMI Collected + Collected Bounce, and EMI Collected =
    // Collected Principal + Collected Interest, so nothing is counted twice.
    { label: 'Collected Bounce', path: 'collectedBounce', type: 'money' },
    { label: 'Bounce Collections', path: 'bounceCollectionCount', type: 'number' },
    { label: 'EMI Collected', path: 'emiCollected', type: 'money' }
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
  /*
   * Every figure below is bounce-scoped, because the rows it summarises are.
   *   Total Received = EMI Collected With Bounce + Bounce Collected
   * Reversed rows stay visible in the table but are excluded from Bounce
   * Collected, exactly as they are excluded from every other collected total.
   */
  [REPORTS.BOUNCE_COLLECTIONS]: [
    { label: 'Bounce Collected', path: 'collectedBounce', type: 'money' },
    { label: 'Bounce Collections', path: 'bounceCollectionCount', type: 'number' },
    { label: 'Posted', path: 'postedCount', type: 'number' },
    { label: 'Posted Amount', path: 'postedAmount', type: 'money' },
    { label: 'Reversed', path: 'reversedCount', type: 'number' },
    { label: 'Reversed Bounce (excluded)', path: 'reversedBounce', type: 'money' },
    { label: 'EMI Collected With Bounce', path: 'emiCollected', type: 'money' },
    { label: 'Total Received', path: 'netCollected', type: 'money' }
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
  ],
  /*
   * One Summary block for every analytics section, so the workbook states the
   * context of whichever section was exported. Absent fields are skipped by the
   * workbook builder, so a section contributes only its own figures.
   */
  [REPORTS.ANALYTICS]: [
    { label: 'Section', path: 'section' },
    { label: 'Grouped By', path: 'bucket' },
    { label: 'As Of', path: 'asOf' },
    { label: 'Period From', path: 'periodFrom' },
    { label: 'Period To', path: 'periodTo' },
    { label: 'Series Points', path: 'pointCount', type: 'number' },
    { label: 'Loans', path: 'loanCount', type: 'number' },
    { label: 'Loan Amount', path: 'loanAmount', type: 'money' },
    { label: 'Gross Demand', path: 'grossDemand', type: 'money' },
    { label: 'Net Demand Outstanding', path: 'netDemand', type: 'money' },
    { label: 'Collections', path: 'collectionCount', type: 'number' },
    { label: 'Collected', path: 'collected', type: 'money' },
    { label: 'EMI Collected', path: 'emiCollected', type: 'money' },
    { label: 'Collected Principal', path: 'collectedPrincipal', type: 'money' },
    { label: 'Collected Interest', path: 'collectedInterest', type: 'money' },
    { label: 'Instalments', path: 'emiCount', type: 'number' },
    { label: 'Instalment Demand', path: 'emiAmount', type: 'money' },
    { label: 'Instalment Collected', path: 'emiAmountCollected', type: 'money' },
    { label: 'Instalment Outstanding', path: 'emiOutstanding', type: 'money' },
    // Assessed and collected are two different facts and are never added.
    { label: 'Bounce Charges Assessed', path: 'bounceAssessed', type: 'money' },
    { label: 'Bounce Actually Collected', path: 'bounceCollected', type: 'money' },
    { label: 'Collections Carrying Bounce', path: 'bounceCollectionCount', type: 'number' }
  ]
});

/** Human titles for the workbook and its sheets. */
const REPORT_TITLES = Object.freeze({
  [REPORTS.LOANS]: 'Loan Report',
  [REPORTS.COLLECTIONS]: 'Collection Report',
  [REPORTS.EMIS]: 'EMI Report',
  [REPORTS.DEMAND_COLLECTIONS]: 'Demand vs Collection Report',
  [REPORTS.BOUNCE_COLLECTIONS]: 'Bounce Collection Report',
  [REPORTS.ANALYTICS]: 'Graph & Analytics'
});

/**
 * Ceiling on an export so a single request cannot pull an unbounded result set
 * into memory. Exceeding it is an explicit error rather than a silent trim.
 */
const EXPORT_MAX_ROWS = 10000;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/**
 * The analytics sections. One request serves one section, so a page showing
 * loans never pays for the collection or instalment aggregation.
 */
const ANALYTICS_SECTIONS = Object.freeze({
  LOANS: 'loans',
  DEMAND: 'demand',
  COLLECTIONS: 'collections',
  EMIS: 'emis',
  BOUNCE: 'bounce',
  DEMAND_VS_COLLECTION: 'demand-vs-collection'
});

const ANALYTICS_SECTION_VALUES = Object.values(ANALYTICS_SECTIONS);

/** How a date series is grouped. */
const ANALYTICS_BUCKETS = Object.freeze({ DAY: 'day', WEEK: 'week', MONTH: 'month' });

const ANALYTICS_BUCKET_VALUES = Object.values(ANALYTICS_BUCKETS);

/**
 * How many points one date series may contain.
 *
 * A chart is unreadable long before this and a browser should not be handed an
 * unbounded series, so a request that would exceed it is refused with the
 * suggestion to widen the grouping — never silently trimmed, which would draw a
 * trend line that stops short of the data behind it. Two years of daily points
 * is the widest anyone can usefully read; week and month grouping cover longer
 * ranges within the same ceiling.
 */
const ANALYTICS_MAX_POINTS = 730;

/** How many categories a non-date series (route, type, mode) may contain. */
const ANALYTICS_MAX_CATEGORIES = 200;

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
 * Restricts a collection query to rows that actually carry bounce money
 * (`bounce_amount > 0`), in SQL.
 *
 * A Symbol for the same reason EXPORT_SCOPE is one: it cannot arrive from a
 * query string, so no caller can turn the ordinary collection report into the
 * bounce report (or the reverse) by guessing a parameter name. Only
 * `bounceCollectionReport` sets it.
 */
const BOUNCE_SCOPE = Symbol('report.bounceOnly');

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
  /*
   * The downloaded Collection Report is deliberately narrower than the screen.
   *
   * Collection Number, CIF, Payment Reference, Status and Counts Toward Totals
   * are NOT exported: they are identifiers and row-level state that the
   * on-screen report still shows in full, and that the API still returns in
   * full. Only this file decides what leaves the system as a file, so removing
   * them here removes them from the workbook itself rather than hiding them.
   *
   * Nothing else moves: the surviving columns keep their existing order,
   * paths, types and formatting, and every money figure is the same value the
   * report computed.
   */
  [REPORTS.COLLECTIONS]: [
    { header: 'Collection Date', path: 'collectionDate', type: 'date' },
    { header: 'Loan Number', path: 'loan.loanNumber', type: 'code' },
    { header: 'Applicant', path: 'customer.fullName' },
    { header: 'Amount', path: 'amount', type: 'money' },
    { header: 'Collected Principal', path: 'collectedPrincipal', type: 'money' },
    { header: 'Collected Interest', path: 'collectedInterest', type: 'money' },
    { header: 'Collected Bounce', path: 'collectedBounce', type: 'money' },
    // Principal + interest: the instalment half of Amount. Amount =
    // EMI Collected + Collected Bounce, exactly.
    { header: 'EMI Collected', path: 'emiCollected', type: 'money' },
    { header: 'Ledger', path: 'ledgerType' },
    { header: 'Route Code', path: 'route.routeCode', type: 'code' },
    { header: 'Collected By', path: 'createdBy' }
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
  /*
   * Bounce Collected here is `collections.bounce_amount` — money actually
   * received — never `emi_schedules.bounce_charge`, which is only what was
   * assessed. Total Received = EMI Collected + Bounce Collected, per row.
   */
  [REPORTS.BOUNCE_COLLECTIONS]: [
    { header: 'Loan Number', path: 'loan.loanNumber', type: 'code' },
    { header: 'Customer', path: 'customer.fullName' },
    { header: 'Total Received', path: 'amount', type: 'money' },
    { header: 'EMI Collected', path: 'emiCollected', type: 'money' },
    { header: 'Bounce Collected', path: 'collectedBounce', type: 'money' },
    { header: 'Ledger', path: 'ledgerType' },
    { header: 'Route', path: 'route.routeCode', type: 'code' },
    { header: 'Collected By', path: 'createdBy' },
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
  ],
  /*
   * Analytics exports every chart of the selected section as rows of one flat
   * shape: which chart, which point, and the figures behind it. A chart whose
   * points carry no count leaves Count empty rather than reporting a zero.
   *
   * As with every other report, this list is the ONLY thing an export may
   * contain — no customer name, mobile, CIFID, loan number or internal id
   * appears in it, because analytics is aggregate by nature and a chart point
   * never identifies a borrower.
   */
  [REPORTS.ANALYTICS]: [
    { header: 'Chart', path: 'chart' },
    { header: 'Series', path: 'series' },
    // A date for a series chart, a route code / status / payment mode for a
    // category one. Written as text either way, so a code is never reformatted
    // and the real date sits in its own column beside it.
    { header: 'Period Or Category', path: 'label', type: 'code' },
    { header: 'Date', path: 'date', type: 'date' },
    { header: 'Count', path: 'count', type: 'number' },
    { header: 'Amount', path: 'amount', type: 'money' }
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
  BOUNCE_SCOPE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ANALYTICS_SECTIONS,
  ANALYTICS_SECTION_VALUES,
  ANALYTICS_BUCKETS,
  ANALYTICS_BUCKET_VALUES,
  ANALYTICS_MAX_POINTS,
  ANALYTICS_MAX_CATEGORIES,
  CSV_COLUMNS
};
