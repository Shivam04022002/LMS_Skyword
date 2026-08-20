'use strict';

const collectionService = require('../services/collectionService');
const receiptService = require('../services/receiptService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/collections */
const listCollections = asyncHandler(async (req, res) => {
  const data = await collectionService.listCollections(req.query);
  return sendSuccess(res, { message: 'Collections fetched successfully', data });
});

/** GET /api/admin/collections/:id */
const getCollection = asyncHandler(async (req, res) => {
  const collection = await collectionService.getCollection(req.params.id);
  return sendSuccess(res, { message: 'Collection fetched successfully', data: { collection } });
});

/** POST /api/admin/collections */
const createCollection = asyncHandler(async (req, res) => {
  const collection = await collectionService.createCollection(req.body, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { statusCode: 201, message: 'Collection posted successfully', data: { collection } });
});

/** POST /api/admin/collections/:id/reverse */
const reverseCollection = asyncHandler(async (req, res) => {
  const collection = await collectionService.reverseCollection(
    req.params.id,
    req.body.reason,
    req.user,
    auditService.contextFrom(req)
  );
  return sendSuccess(res, { message: 'Collection reversed successfully', data: { collection } });
});

/** GET /api/admin/loans/:loanId/collection-summary */
const getLoanSummary = asyncHandler(async (req, res) => {
  const summary = await collectionService.getLoanCollectionSummary(req.params.loanId);
  return sendSuccess(res, { message: 'Loan collection summary fetched successfully', data: { summary } });
});

/**
 * GET /api/admin/collections/:id/receipt
 * Read-only view of an existing collection — writes nothing.
 */
const getReceipt = asyncHandler(async (req, res) => {
  const receipt = await receiptService.getReceipt(req.params.id, req.user);
  return sendSuccess(res, { message: 'Receipt generated successfully', data: { receipt } });
});

module.exports = { listCollections, getCollection, createCollection, reverseCollection, getLoanSummary, getReceipt };
