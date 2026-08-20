'use strict';

const emiScheduleService = require('../services/emiScheduleService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

/** GET /api/admin/loans/:loanId/emis */
const listSchedule = asyncHandler(async (req, res) => {
  const data = await emiScheduleService.listSchedule(req.params.loanId, req.query);
  return sendSuccess(res, { message: 'EMI schedule fetched successfully', data });
});

/** GET /api/admin/loans/:loanId/emis/:emiId */
const getEmi = asyncHandler(async (req, res) => {
  const emi = await emiScheduleService.getEmi(req.params.loanId, req.params.emiId);
  return sendSuccess(res, { message: 'EMI fetched successfully', data: { emi } });
});

/**
 * POST /api/admin/loans/:loanId/emis/generate
 *
 * Recovery path only — activation is the normal way a schedule comes into
 * existence. Requires an ACTIVE loan with no schedule; an existing schedule is a
 * 409 rather than a silent rebuild.
 */
const generateSchedule = asyncHandler(async (req, res) => {
  const actor = { id: req.user.id, ipAddress: req.ip };
  await emiScheduleService.generateSchedule(req.params.loanId, actor, { conflictOnExisting: true });

  const data = await emiScheduleService.listSchedule(req.params.loanId);
  return sendSuccess(res, { statusCode: 201, message: 'EMI schedule generated successfully', data });
});

/**
 * POST /api/admin/loans/:loanId/emis/recalculate
 * Refreshes the stored DPD and status snapshots. Changes no money, no dates and
 * no instalment count.
 */
const recalculate = asyncHandler(async (req, res) => {
  const data = await emiScheduleService.recalculateSnapshots(req.params.loanId, req.user, auditService.contextFrom(req));
  return sendSuccess(res, { message: 'EMI snapshots recalculated successfully', data });
});

/**
 * PATCH /api/admin/loans/:loanId/emis/:emiId/bounce-charge
 *
 * The single mutable field on an instalment. Send 0 to clear a charge.
 */
const updateBounceCharge = asyncHandler(async (req, res) => {
  const emi = await emiScheduleService.setBounceCharge(
    req.params.loanId,
    req.params.emiId,
    req.body.bounceCharge,
    req.user,
    auditService.contextFrom(req)
  );
  return sendSuccess(res, { message: 'Bounce charge saved successfully', data: { emi } });
});

module.exports = { listSchedule, getEmi, generateSchedule, recalculate, updateBounceCharge };
