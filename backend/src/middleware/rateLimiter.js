'use strict';

const rateLimit = require('express-rate-limit');
const { sendError } = require('../utils/apiResponse');
const config = require('../config/env');

const handler = (req, res) =>
  sendError(res, {
    statusCode: 429,
    message: 'Too many requests, please try again later',
    errors: []
  });

/** Broad ceiling applied to the whole API surface. */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.isProduction ? 300 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler
});

/** Tighter limit on credential submission to blunt brute-force attempts. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.isProduction ? 10 : 50,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler
});

module.exports = { apiLimiter, authLimiter };
