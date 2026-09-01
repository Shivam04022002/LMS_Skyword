import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

export const getLoanReport = (params) => api.get('/admin/reports/loans', { params: toQuery(params) });

export const getCollectionReport = (params) => api.get('/admin/reports/collections', { params: toQuery(params) });

export const getEmiReport = (params) => api.get('/admin/reports/emis', { params: toQuery(params) });

export const getDemandCollectionReport = (params) => api.get('/admin/reports/demand-collections', { params: toQuery(params) });

/**
 * Bounce Collection report — collections that actually carried bounce money.
 *
 * The backend applies `bounce_amount > 0` in SQL, so this never pulls every
 * collection down to filter in the browser.
 */
export const getBounceCollectionReport = (params) =>
  api.get('/admin/reports/bounce-collections', { params: toQuery(params) });

/**
 * Downloads a report as CSV.
 *
 * Goes through the shared Axios client so the auth header, the 401 handler and
 * error normalisation all apply — a plain anchor href could not carry the token.
 * The same filters are sent, so the file matches what is on screen; the backend
 * builds the rows from the identical query.
 */
export async function exportReportCsv(reportKey, params = {}) {
  return downloadReport(reportKey, params, 'csv');
}

/**
 * Downloads a report as a real .xlsx workbook, with a Summary sheet.
 *
 * Same call, same filters, same rows — only the rendering differs, and the
 * backend builds the file so the totals in it are the report's own.
 */
export async function exportReportExcel(reportKey, params = {}) {
  return downloadReport(reportKey, params, 'xlsx');
}

const EXPORT_EXTENSION = { csv: 'csv', xlsx: 'xlsx' };

async function downloadReport(reportKey, params, format) {
  const blob = await api.get(`/admin/reports/${reportKey}`, {
    params: toQuery({ ...params, format }),
    responseType: 'blob'
  });

  const stamp = params.date ?? params.dateFrom ?? new Date().toISOString().slice(0, 10);
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `lms-${reportKey}-${String(stamp).slice(0, 10)}.${EXPORT_EXTENSION[format]}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
