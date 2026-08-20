import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

export const getLoans = (params) => api.get('/admin/loans', { params: toQuery(params) });

export const getLoan = (id) => api.get(`/admin/loans/${id}`);

export const createLoan = (payload) => api.post('/admin/loans', payload);

export const updateLoan = (id, payload) => api.put(`/admin/loans/${id}`, payload);

export const updateLoanStatus = (id, status) => api.patch(`/admin/loans/${id}/status`, { status });

/**
 * Preview figures for the form. Deliberately a backend call: the repayment
 * formula lives in one place, so the preview can never drift from what is
 * actually stored.
 */
export const previewLoanFinancials = (terms) => api.post('/admin/loans/preview', terms);

/**
 * Bulk import.
 *
 * `Content-Type: undefined` is essential: the shared client declares
 * application/json for every request, and that default wins over the multipart
 * type Axios derives from a FormData body — the file is dropped during
 * serialisation and the request arrives with no file at all. Clearing it for
 * these two calls lets the browser set the boundary itself.
 *
 * The workbook carries terms only. Every figure comes back from the backend.
 */
const MULTIPART = { headers: { 'Content-Type': undefined } };

function spreadsheetForm(file) {
  const form = new FormData();
  form.append('file', file);
  return form;
}

export const previewLoanImport = (file) => api.post('/admin/loans/import/preview', spreadsheetForm(file), MULTIPART);

export const runLoanImport = (file) => api.post('/admin/loans/import', spreadsheetForm(file), MULTIPART);

/** Downloads the blank template workbook. */
export async function downloadLoanImportTemplate() {
  const blob = await api.get('/admin/loans/import/template', { responseType: 'blob' });

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'lms-loan-import-template.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
