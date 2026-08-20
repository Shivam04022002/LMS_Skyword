'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Terminal route matcher. Guarantees a JSON 404 instead of Express' default
 * HTML error page.
 */
function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} was not found`));
}

module.exports = notFoundHandler;
