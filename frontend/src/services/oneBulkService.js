import api from './api';

/*
 * TEMPORARY: oneBulk historical collection migration utility.
 * Can be removed after historical collections are migrated — delete this
 * file and the two files that use it (OneBulkImport component and page).
 * Nothing else in the frontend imports from here.
 */

const MULTIPART = { headers: { 'Content-Type': undefined } };

function spreadsheetForm(file) {
  const form = new FormData();
  form.append('file', file);
  return form;
}

export const previewOneBulkImport = (file) => api.post('/admin/one-bulk/preview', spreadsheetForm(file), MULTIPART);

export const runOneBulkImport = (file) => api.post('/admin/one-bulk', spreadsheetForm(file), MULTIPART);

/** Downloads the blank oneBulk template workbook. */
export async function downloadOneBulkTemplate() {
  const blob = await api.get('/admin/one-bulk/template', { responseType: 'blob' });

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'lms-one-bulk-import-template.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
