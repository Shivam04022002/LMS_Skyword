'use strict';

const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyToken } = require('../utils/jwt');
const { User } = require('../models');
const { USER_STATUS } = require('../config/roles');

/**
 * Accepts the token from the Authorization header, falling back to the
 * httpOnly cookie set at login.
 */
function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  return null;
}

/**
 * Validates the JWT and attaches the current user to `req.user`.
 * The user is re-read on every request so a deactivated account loses access
 * immediately instead of when its token expires.
 */
const authMiddleware = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    throw ApiError.unauthorized('Authentication token is missing');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    const message =
      error.name === 'TokenExpiredError' ? 'Session expired, please log in again' : 'Invalid authentication token';
    throw ApiError.unauthorized(message);
  }

  // Loaded with the role and its permissions so authorisation checks downstream
  // need no further queries.
  const user = await User.scope('withRole').findByPk(payload.sub);

  if (!user) {
    throw ApiError.unauthorized('The account linked to this token no longer exists');
  }

  if (user.status !== USER_STATUS.ACTIVE) {
    throw ApiError.forbidden('This account is inactive');
  }

  req.user = user;
  req.userId = user.id;
  next();
});

module.exports = authMiddleware;
