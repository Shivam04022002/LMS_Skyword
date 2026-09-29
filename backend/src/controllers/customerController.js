'use strict';

const customerService = require('../services/customerService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const reportExcelService = require('../services/reportExcelService');
const {
  CUSTOMER_EXPORT_COLUMNS,
  CUSTOMER_EXPORT_SHEET_TITLE,
  customerExportFilename
} = require('../config/customers');
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = require('../config/auditActions');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/customers */
/**
 * GET /api/admin/customers/export
 *
 * The current search and filters, rendered as a workbook — every matching
 * customer, not the page on screen. The rows come from the same query the list
 * uses, and the file is built by the shared report renderer, so the styling,
 * the text/date cell handling and the summary sheet are the ones every other
 * export already has.
 *
 * A download leaves the system's access controls behind, so it is audited the
 * same way a report export is.
 */
const exportCustomers = asyncHandler(async (req, res) => {
  const { customers, total } = await customerService.exportCustomers(req.query);

  const generatedAt = new Date();
  const workbook = await reportExcelService.buildReportWorkbook({
    columns: [...CUSTOMER_EXPORT_COLUMNS],
    title: CUSTOMER_EXPORT_SHEET_TITLE,
    // No totals to report: a customer list has no money to sum. The Summary
    // sheet still records when it was generated, how many rows it holds and
    // which filters produced it.
    summaryFields: [],
    rows: customers,
    filters: req.query,
    generatedAt
  });

  await auditService.record({
    ...auditService.contextFrom(req),
    action: AUDIT_ACTIONS.REPORT_EXPORTED,
    entity: AUDIT_ENTITIES.CUSTOMER,
    entityId: null,
    details: { export: 'customers', format: 'xlsx', rowCount: total, filters: sanitizeFilters(req.query) }
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${customerExportFilename(generatedAt)}"`);
  res.setHeader('Content-Length', workbook.length);
  return res.status(200).send(workbook);
});

/** Records which filters produced an export, without echoing paging noise. */
function sanitizeFilters(query) {
  const { page, limit, ...rest } = query;
  return rest;
}

const listCustomers = asyncHandler(async (req, res) => {
  const data = await customerService.listCustomers(req.query);
  return sendSuccess(res, { message: 'Customers fetched successfully', data });
});

/** GET /api/admin/customers/:id */
const getCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomerById(req.params.id);
  return sendSuccess(res, { message: 'Customer fetched successfully', data: { customer } });
});

/** POST /api/admin/customers */
const createCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.createCustomer(req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'Customer created successfully', data: { customer } });
});

/** PUT /api/admin/customers/:id */
const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.updateCustomer(req.params.id, req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'Customer updated successfully', data: { customer } });
});

/** PATCH /api/admin/customers/:id/status */
const changeStatus = asyncHandler(async (req, res) => {
  const customer = await customerService.changeStatus(req.params.id, req.body.status, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'Customer status updated successfully', data: { customer } });
});

module.exports = { listCustomers, exportCustomers, getCustomer, createCustomer, updateCustomer, changeStatus };
