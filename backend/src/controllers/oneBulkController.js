'use strict';

/*
 * TEMPORARY: oneBulk historical collection migration utility.
 * Can be removed after historical collections are migrated.
 */

const oneBulkImportService = require('../services/oneBulkImportService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { TEMPLATE_FILENAME } = require('../config/oneBulk');

/**
 * GET /api/admin/one-bulk/template
 * The blank workbook, built from the same column definitions the parser reads.
 */
const downloadTemplate = asyncHandler(async (req, res) => {
  const { buffer, filename } = await oneBulkImportService.buildTemplate();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename ?? TEMPLATE_FILENAME}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

/**
 * POST /api/admin/one-bulk/preview
 * Parses, validates and plans the allocation only. This path performs no writes.
 */
const previewImport = asyncHandler(async (req, res) => {
  const data = await oneBulkImportService.previewImport(req.file.buffer, { filename: req.file.originalname });
  return sendSuccess(res, { message: 'oneBulk import preview generated successfully', data });
});

/**
 * POST /api/admin/one-bulk
 * Re-validates the workbook from scratch and posts it whole, or not at all.
 */
const runImport = asyncHandler(async (req, res) => {
  const data = await oneBulkImportService.runImport(req.file.buffer, req.user, auditService.contextFrom(req), {
    filename: req.file.originalname
  });
  return sendSuccess(res, { statusCode: 201, message: 'oneBulk historical collections imported successfully', data });
});

module.exports = { downloadTemplate, previewImport, runImport };
