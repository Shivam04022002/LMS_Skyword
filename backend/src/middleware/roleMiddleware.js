'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Restricts a route to the given roles. Must run after `authMiddleware`.
 *
 *   router.get('/users', authMiddleware, requireRole('ADMIN'), handler);
 *   router.delete('/users/:id', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), handler);
 */
function requireRole(...allowedRoles) {
  const allowed = allowedRoles.flat();

  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication is required'));
    }
    if (allowed.length > 0 && !allowed.includes(req.user.role)) {
      return next(ApiError.forbidden('You do not have permission to perform this action'));
    }
    return next();
  };
}

module.exports = requireRole;
