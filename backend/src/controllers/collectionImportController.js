'use strict';

const collectionImportService = require('../services/collectionImportService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { TEMPLATE_FILENAME } = require('../config/collectionImport');

/**
 * GET /api/admin/collections/import/template
 * The blank workbook, built from the same column definitions the parser reads.
 */
const downloadTemplate = asyncHandler(async (req, res) => {
  const { buffer, filename } = await collectionImportService.buildTemplate();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename ?? TEMPLATE_FILENAME}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

/**
 * POST /api/admin/collections/import/preview
 * Parses, validates and plans the allocation only. This path performs no writes.
 */
const previewImport = asyncHandler(async (req, res) => {
  const data = await collectionImportService.previewImport(req.file.buffer, { filename: req.file.originalname });
  return sendSuccess(res, { message: 'Collection import preview generated successfully', data });
});

/**
 * POST /api/admin/collections/import
 * Re-validates the workbook from scratch and posts it whole, or not at all.
 */
const runImport = asyncHandler(async (req, res) => {
  const data = await collectionImportService.runImport(req.file.buffer, req.user, auditService.contextFrom(req), {
    filename: req.file.originalname
  });
  return sendSuccess(res, { statusCode: 201, message: 'Collections imported successfully', data });
});

module.exports = { downloadTemplate, previewImport, runImport };
