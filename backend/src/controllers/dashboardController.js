'use strict';

const dashboardService = require('../services/dashboardService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/**
 * GET /api/admin/dashboard
 *
 * One endpoint returns every KPI section, so the UI makes a single request
 * rather than one per card. Read-only: nothing is written and, unlike an export,
 * a dashboard view is not audited.
 */
const getDashboard = asyncHandler(async (req, res) => {
  const data = await dashboardService.getDashboard(req.query, req.user);
  return sendSuccess(res, { message: 'Dashboard generated successfully', data });
});

module.exports = { getDashboard };
