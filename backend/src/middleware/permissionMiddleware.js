'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Restricts a route to holders of the given permission(s).
 * Must run after `authMiddleware`, which loads the user together with the role
 * and its permissions — no JWT verification is repeated here.
 *
 *   router.get('/users', authMiddleware, requirePermission('users.view'), handler);
 *
 * Multiple permissions are treated as "all of them are required".
 */
function requirePermission(...requiredPermissions) {
  const required = requiredPermissions.flat();

  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication is required'));
    }

    const granted = req.user.permissionNames();
    const missing = required.filter((permission) => !granted.includes(permission));

    if (missing.length > 0) {
      return next(ApiError.forbidden('You do not have permission to perform this action'));
    }

    return next();
  };
}

/** Passes when the user holds at least one of the listed permissions. */
function requireAnyPermission(...requiredPermissions) {
  const required = requiredPermissions.flat();

  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication is required'));
    }

    const granted = req.user.permissionNames();

    if (required.length > 0 && !required.some((permission) => granted.includes(permission))) {
      return next(ApiError.forbidden('You do not have permission to perform this action'));
    }

    return next();
  };
}

module.exports = { requirePermission, requireAnyPermission };
