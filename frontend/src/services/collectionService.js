import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

export const getCollections = (params) => api.get('/admin/collections', { params: toQuery(params) });

export const getCollection = (id) => api.get(`/admin/collections/${id}`);

/** Amount, date, ledger and explicit allocations; the backend derives the rest. */
export const createCollection = (payload) => api.post('/admin/collections', payload);

export const reverseCollection = (id, reason) => api.post(`/admin/collections/${id}/reverse`, reason ? { reason } : {});

export const getLoanCollectionSummary = (loanId) => api.get(`/admin/loans/${loanId}/collection-summary`);

/** Read-only receipt view of an existing collection. */
export const getCollectionReceipt = (id) => api.get(`/admin/collections/${id}/receipt`);

/**
 * Bulk import.
 *
 * `Content-Type: undefined` is essential: the shared client declares
 * application/json for every request, and that default wins over the multipart
 * type Axios derives from a FormData body — the file is dropped during
 * serialisation and the request arrives with no file at all. Clearing it for
 * these two calls lets the browser set the boundary itself.
 *
 * The workbook carries payments only. Allocation is decided by the backend.
 */
const MULTIPART = { headers: { 'Content-Type': undefined } };

function spreadsheetForm(file) {
  const form = new FormData();
  form.append('file', file);
  return form;
}

export const previewCollectionImport = (file) =>
  api.post('/admin/collections/import/preview', spreadsheetForm(file), MULTIPART);

export const runCollectionImport = (file) => api.post('/admin/collections/import', spreadsheetForm(file), MULTIPART);

/** Downloads the blank template workbook. */
export async function downloadCollectionImportTemplate() {
  const blob = await api.get('/admin/collections/import/template', { responseType: 'blob' });

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'lms-collection-import-template.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
