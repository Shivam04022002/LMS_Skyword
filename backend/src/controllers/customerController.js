'use strict';

const customerService = require('../services/customerService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/customers */
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

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, changeStatus };
