'use strict';

const {
  ValidationError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
  ConnectionError,
  DatabaseError
} = require('sequelize');
const ApiError = require('../utils/ApiError');
const { sendError } = require('../utils/apiResponse');
const config = require('../config/env');

/**
 * Maps a thrown error onto { statusCode, message, errors }.
 * Anything not recognised is reported as a 500 with a generic message so
 * internals never reach the client.
 */
function normalizeError(error) {
  if (error instanceof ApiError) {
    return { statusCode: error.statusCode, message: error.message, errors: error.errors };
  }

  if (error instanceof UniqueConstraintError) {
    return {
      statusCode: 409,
      message: 'A record with these details already exists',
      errors: error.errors.map((item) => ({ field: item.path, message: item.message }))
    };
  }

  if (error instanceof ValidationError) {
    return {
      statusCode: 422,
      message: 'Validation failed',
      errors: error.errors.map((item) => ({ field: item.path, message: item.message }))
    };
  }

  if (error instanceof ForeignKeyConstraintError) {
    return { statusCode: 409, message: 'This record is referenced by other data', errors: [] };
  }

  if (error instanceof ConnectionError) {
    return { statusCode: 503, message: 'Database is unavailable, please try again later', errors: [] };
  }

  if (error instanceof DatabaseError) {
    return { statusCode: 500, message: 'A database error occurred', errors: [] };
  }

  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return { statusCode: 401, message: 'Invalid or expired authentication token', errors: [] };
  }

  // Malformed JSON body rejected by express.json()
  if (error.type === 'entity.parse.failed') {
    return { statusCode: 400, message: 'Request body contains invalid JSON', errors: [] };
  }

  if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
    return { statusCode: error.statusCode, message: error.message, errors: [] };
  }

  return { statusCode: 500, message: 'Internal server error', errors: [] };
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
function errorHandler(error, req, res, next) {
  const { statusCode, message, errors } = normalizeError(error);

  // Unexpected failures are always logged in full on the server, never returned.
  if (statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, error);
  }

  const payload = { statusCode, message, errors };

  if (!config.isProduction && statusCode >= 500) {
    payload.errors = [...errors, { field: 'stack', message: error.stack }];
  }

  return sendError(res, payload);
}

module.exports = errorHandler;
