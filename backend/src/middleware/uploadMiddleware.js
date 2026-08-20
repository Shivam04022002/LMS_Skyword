'use strict';

const path = require('path');
const multer = require('multer');
const ApiError = require('../utils/ApiError');
const { MAX_FILE_BYTES, ACCEPTED_EXTENSIONS, ACCEPTED_MIME_TYPES } = require('../config/customerImport');

/**
 * Spreadsheet upload.
 *
 * The file is held in memory and never written to disk, so nothing uploadable
 * ever lands on the filesystem where it could be served or executed. Multer
 * enforces the size limit while streaming, so an oversized file is rejected
 * before it is fully buffered rather than after.
 *
 * Extension and content type are checked here; the parser separately checks the
 * file's magic bytes, because both of these are client-supplied claims.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 1,
    fields: 4,
    parts: 6
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname ?? '').toLowerCase();

    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      return callback(ApiError.badRequest(`Only ${ACCEPTED_EXTENSIONS.join(', ')} files are accepted`));
    }
    if (file.mimetype && !ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
      return callback(ApiError.badRequest('That file is not an Excel workbook'));
    }
    return callback(null, true);
  }
});

/**
 * Accepts one spreadsheet on `field`, turning multer's own errors into the
 * project's ApiError shape so the response envelope stays consistent.
 */
function uploadSpreadsheet(field = 'file') {
  const handler = upload.single(field);

  return (req, res, next) =>
    handler(req, res, (error) => {
      if (!error) {
        if (!req.file) {
          return next(ApiError.badRequest('Attach a .xlsx file to import'));
        }
        return next();
      }

      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return next(ApiError.badRequest(`The file is larger than ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB`));
        }
        if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(ApiError.badRequest('Upload exactly one file'));
        }
        return next(ApiError.badRequest('That upload could not be read'));
      }

      return next(error);
    });
}

module.exports = { uploadSpreadsheet };
