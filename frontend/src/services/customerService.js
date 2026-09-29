import api from './api';

/** Strips empty filters so they do not appear as blank query parameters. */
function toQuery(params = {}) {
  return Object.entries(params).reduce((accumulator, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') accumulator[key] = value;
    return accumulator;
  }, {});
}

export const getCustomers = (params) => api.get('/admin/customers', { params: toQuery(params) });

export const getCustomer = (id) => api.get(`/admin/customers/${id}`);

export const createCustomer = (payload) => api.post('/admin/customers', payload);

export const updateCustomer = (id, payload) => api.put(`/admin/customers/${id}`, payload);

export const updateCustomerStatus = (id, status) => api.patch(`/admin/customers/${id}/status`, { status });

/**
 * Bulk import.
 *
 * The workbook is posted as multipart form data through the shared Axios
 * client, so the auth header, the 401 handler and error normalisation all still
 * apply.
 *
 * `Content-Type: undefined` is essential, not decoration. The shared client
 * declares `application/json` for every request, and that default wins over the
 * multipart type Axios would otherwise derive from a FormData body — the file
 * is then dropped during serialisation and the request arrives with no file at
 * all. Clearing the header for these two calls lets the browser set
 * `multipart/form-data` and generate the boundary itself. The default is left
 * alone for every other request.
 *
 * The same file is sent twice — once to preview, once to import — and the
 * backend re-validates it from scratch the second time. Nothing from the
 * preview response is trusted as an instruction to write.
 */
const MULTIPART = { headers: { 'Content-Type': undefined } };

function spreadsheetForm(file) {
  const form = new FormData();
  form.append('file', file);
  return form;
}

export const previewCustomerImport = (file) =>
  api.post('/admin/customers/import/preview', spreadsheetForm(file), MULTIPART);

export const runCustomerImport = (file) => api.post('/admin/customers/import', spreadsheetForm(file), MULTIPART);

/** Downloads the blank template workbook. */
export async function downloadCustomerImportTemplate() {
  const blob = await api.get('/admin/customers/import/template', { responseType: 'blob' });
  saveBlob(blob, 'lms-customer-import-template.xlsx');
}

/**
 * Downloads the customer list as a workbook.
 *
 * The SAME filters the screen is showing are sent, and the backend exports
 * every matching customer rather than the page on screen — so the file cannot
 * disagree with the list, and paging is not silently applied to it. `page` and
 * `limit` are deliberately not passed.
 *
 * Goes through the shared Axios client so the auth header, the 401 handler and
 * error normalisation all still apply; a plain anchor href could not carry the
 * token.
 */
export async function exportCustomersExcel(params = {}) {
  const blob = await api.get('/admin/customers/export', { params: toQuery(params), responseType: 'blob' });
  saveBlob(blob, `LMS_Customers_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/** Hands a downloaded blob to the browser under the given filename. */
function saveBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
