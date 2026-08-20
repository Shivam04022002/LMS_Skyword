'use strict';

const loanService = require('../services/loanService');
const auditService = require('../services/auditService');
const { calculateLoanFinancials } = require('../services/loanCalculationService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/loans */
const listLoans = asyncHandler(async (req, res) => {
  const data = await loanService.listLoans(req.query);
  return sendSuccess(res, { message: 'Loans fetched successfully', data });
});

/** GET /api/admin/loans/:id */
const getLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.getLoanById(req.params.id);
  return sendSuccess(res, { message: 'Loan fetched successfully', data: { loan } });
});

/** POST /api/admin/loans */
const createLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.createLoan(req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'Loan created successfully', data: { loan } });
});

/** PUT /api/admin/loans/:id */
const updateLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.updateLoan(req.params.id, req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'Loan updated successfully', data: { loan } });
});

/** PATCH /api/admin/loans/:id/status */
const changeStatus = asyncHandler(async (req, res) => {
  const loan = await loanService.changeStatus(req.params.id, req.body.status, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'Loan status updated successfully', data: { loan } });
});

/**
 * POST /api/admin/loans/preview
 * Returns the same figures creation would store, so the form can show them
 * before saving without duplicating the formula in the browser.
 */
const previewFinancials = asyncHandler(async (req, res) => {
  const {
    loanAmount, roi, tenure, loanType, startDate, interestMethod, weeklyOff, roiBasis, tenureUnit, collectionCount
  } = req.body;
  const financials = calculateLoanFinancials({
    loanAmount,
    roi,
    tenure,
    loanType,
    startDate,
    interestMethod,
    weeklyOff,
    ...(tenureUnit ? { tenureUnit } : {}),
    ...(collectionCount !== undefined && collectionCount !== null && collectionCount !== '' ? { collectionCount } : {}),
    // Only ever supplied when previewing an existing loan, so an edit form
    // shows the same figures the save will store.
    ...(roiBasis ? { roiBasis } : {})
  });
  return sendSuccess(res, { message: 'Loan financials calculated', data: { financials } });
});

module.exports = { listLoans, getLoan, createLoan, updateLoan, changeStatus, previewFinancials };
