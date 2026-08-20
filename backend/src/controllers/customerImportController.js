'use strict';

const customerImportService = require('../services/customerImportService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { TEMPLATE_FILENAME } = require('../config/customerImport');

/**
 * GET /api/admin/customers/import/template
 * The blank workbook, built from the same column definitions the parser reads.
 */
const downloadTemplate = asyncHandler(async (req, res) => {
  const { buffer, filename } = await customerImportService.buildTemplate();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename ?? TEMPLATE_FILENAME}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

/**
 * POST /api/admin/customers/import/preview
 * Parses and validates only. This path performs no database writes.
 */
const previewImport = asyncHandler(async (req, res) => {
  const data = await customerImportService.previewImport(req.file.buffer, { filename: req.file.originalname });
  return sendSuccess(res, { message: 'Import preview generated successfully', data });
});

/**
 * POST /api/admin/customers/import
 * Re-validates the workbook from scratch and imports the rows that pass.
 */
const runImport = asyncHandler(async (req, res) => {
  const data = await customerImportService.runImport(req.file.buffer, req.user, auditService.contextFrom(req), {
    filename: req.file.originalname
  });
  return sendSuccess(res, { statusCode: 201, message: 'Customers imported successfully', data });
});

module.exports = { downloadTemplate, previewImport, runImport };
