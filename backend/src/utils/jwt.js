'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');

/**
 * Issues an access token. The payload deliberately stays minimal: the user is
 * always re-read from the database when the token is used.
 */
function signToken({ id, role }) {
  return jwt.sign({ sub: String(id), role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn
  });
}

/**
 * Verifies a token and returns its payload.
 * Throws jsonwebtoken errors, which the error middleware maps to HTTP 401.
 */
function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

/** Expiry of an issued token as a Date, used to align the cookie lifetime. */
function getTokenExpiry(token) {
  const decoded = jwt.decode(token);
  return decoded && decoded.exp ? new Date(decoded.exp * 1000) : null;
}

module.exports = { signToken, verifyToken, getTokenExpiry };
