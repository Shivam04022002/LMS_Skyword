'use strict';

const loanImportService = require('../services/loanImportService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { TEMPLATE_FILENAME } = require('../config/loanImport');

/**
 * GET /api/admin/loans/import/template
 * The blank workbook, built from the same column definitions the parser reads.
 */
const downloadTemplate = asyncHandler(async (req, res) => {
  const { buffer, filename } = await loanImportService.buildTemplate();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename ?? TEMPLATE_FILENAME}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

/**
 * POST /api/admin/loans/import/preview
 * Parses, validates and prices only. This path performs no database writes.
 */
const previewImport = asyncHandler(async (req, res) => {
  const data = await loanImportService.previewImport(req.file.buffer, { filename: req.file.originalname });
  return sendSuccess(res, { message: 'Loan import preview generated successfully', data });
});

/**
 * POST /api/admin/loans/import
 * Re-validates the workbook from scratch and imports it whole, or not at all.
 */
const runImport = asyncHandler(async (req, res) => {
  const data = await loanImportService.runImport(req.file.buffer, req.user, auditService.contextFrom(req), {
    filename: req.file.originalname
  });
  return sendSuccess(res, { statusCode: 201, message: 'Loans imported successfully', data });
});

module.exports = { downloadTemplate, previewImport, runImport };
