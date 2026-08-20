'use strict';

const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');
const { getTokenExpiry } = require('../utils/jwt');
const config = require('../config/env');

const COOKIE_NAME = 'token';

/**
 * The token is also mirrored into an httpOnly cookie so that a browser client
 * can survive a page reload without exposing the token to scripts.
 */
function cookieOptions(token) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    expires: getTokenExpiry(token) ?? undefined
  };
}

/** POST /api/auth/login */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const { token, user } = await authService.login({ email, password });

  res.cookie(COOKIE_NAME, token, cookieOptions(token));

  return sendSuccess(res, {
    message: 'Login successful',
    data: {
      token,
      // Phase 1 fields kept as-is; `permissions` is additive so existing
      // clients are unaffected.
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions: user.permissions
      }
    }
  });
});

/** GET /api/auth/me — requires a valid JWT. */
const me = asyncHandler(async (req, res) => {
  const user = await authService.getProfile(req.userId);

  return sendSuccess(res, {
    message: 'Authenticated user retrieved',
    data: { user }
  });
});

/** POST /api/auth/logout — clears the auth cookie. */
const logout = asyncHandler(async (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: config.isProduction });

  return sendSuccess(res, { message: 'Logout successful', data: {} });
});

module.exports = { login, me, logout };
