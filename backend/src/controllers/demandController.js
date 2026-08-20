'use strict';

const demandService = require('../services/demandService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/demand */
const getDemand = asyncHandler(async (req, res) => {
  const data = await demandService.getDemand(
    { ...req.query, includeUpcoming: req.query.includeUpcoming === 'true' },
    req.user
  );
  return sendSuccess(res, { message: 'Demand fetched successfully', data });
});

/** GET /api/admin/demand/routes — route-level roll-up for planning a day. */
const getRouteSummary = asyncHandler(async (req, res) => {
  const data = await demandService.getRouteDemandSummary(req.query, req.user);
  return sendSuccess(res, { message: 'Route demand summary fetched successfully', data });
});

module.exports = { getDemand, getRouteSummary };
