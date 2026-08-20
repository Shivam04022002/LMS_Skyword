'use strict';

/**
 * Single source of truth for the response envelope. Every controller and every
 * piece of middleware answers through these two helpers so clients can rely on
 * one shape.
 */

function sendSuccess(res, { statusCode = 200, message = 'Operation successful', data = {} } = {}) {
  return res.status(statusCode).json({
    success: true,
    message,
    data: data ?? {}
  });
}

function sendError(res, { statusCode = 500, message = 'Something went wrong', errors = [] } = {}) {
  return res.status(statusCode).json({
    success: false,
    message,
    errors
  });
}

module.exports = { sendSuccess, sendError };
