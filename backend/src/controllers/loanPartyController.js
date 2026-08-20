'use strict';

const loanPartyService = require('../services/loanPartyService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/loans/:loanId/parties */
const listParties = asyncHandler(async (req, res) => {
  const data = await loanPartyService.listParties(req.params.loanId, {
    includeRemoved: req.query.includeRemoved === 'true'
  });
  return sendSuccess(res, { message: 'Loan parties fetched successfully', data });
});

/** POST /api/admin/loans/:loanId/parties */
const addParty = asyncHandler(async (req, res) => {
  const party = await loanPartyService.addParty(req.params.loanId, req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'Party added successfully', data: { party } });
});

/** PUT /api/admin/loans/:loanId/parties/:partyId */
const updateParty = asyncHandler(async (req, res) => {
  const party = await loanPartyService.updateParty(
    req.params.loanId,
    req.params.partyId,
    req.body,
    req.user,
    auditService.contextFrom(req)
  );
  return sendSuccess(res, { message: 'Party updated successfully', data: { party } });
});

/** PATCH /api/admin/loans/:loanId/parties/:partyId/status — soft removal. */
const changePartyStatus = asyncHandler(async (req, res) => {
  const party = await loanPartyService.changePartyStatus(
    req.params.loanId,
    req.params.partyId,
    req.body.status,
    req.user,
    auditService.contextFrom(req)
  );
  return sendSuccess(res, { message: 'Party status updated successfully', data: { party } });
});

/** POST /api/admin/loans/:loanId/parties/swap */
const swapApplicant = asyncHandler(async (req, res) => {
  const data = await loanPartyService.swapApplicantAndCoApplicant(
    req.params.loanId,
    req.body,
    req.user,
    auditService.contextFrom(req)
  );
  return sendSuccess(res, { message: 'Applicant and co-applicant swapped successfully', data });
});

module.exports = { listParties, addParty, updateParty, changePartyStatus, swapApplicant };
