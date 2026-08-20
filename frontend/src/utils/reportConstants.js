/** Mirrors backend/src/config/reports.js. */
export const REPORTS = Object.freeze({
  LOANS: 'loans',
  COLLECTIONS: 'collections',
  EMIS: 'emis',
  DEMAND_COLLECTIONS: 'demand-collections'
});

export const REPORT_PAGES = [
  { key: REPORTS.LOANS, path: '/reports/loans', label: 'Loan report', icon: 'bi-cash-coin' },
  { key: REPORTS.COLLECTIONS, path: '/reports/collections', label: 'Collection report', icon: 'bi-receipt' },
  { key: REPORTS.EMIS, path: '/reports/emis', label: 'EMI report', icon: 'bi-list-ol' },
  { key: REPORTS.DEMAND_COLLECTIONS, path: '/reports/demand', label: 'Demand vs collection', icon: 'bi-bar-chart' }
];

export const DEFAULT_PAGE_SIZE = 25;
