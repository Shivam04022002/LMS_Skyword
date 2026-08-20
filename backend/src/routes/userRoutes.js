'use strict';

const express = require('express');
const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const { USER_STATUS } = require('../config/roles');
const {
  listUsersRules,
  userIdRules,
  createUserRules,
  updateUserRules,
  changeStatusRules,
  changeRoleRules,
  resetPasswordRules
} = require('../validators/userValidator');

const router = express.Router();

// Everything below requires a valid JWT.
router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.USERS_VIEW), validate(listUsersRules), userController.listUsers);

router.get('/:id', requirePermission(PERMISSIONS.USERS_VIEW), validate(userIdRules), userController.getUser);

router.post('/', requirePermission(PERMISSIONS.USERS_CREATE), validate(createUserRules), userController.createUser);

router.put('/:id', requirePermission(PERMISSIONS.USERS_UPDATE), validate(updateUserRules), userController.updateUser);

/**
 * Activation and deactivation are distinct permissions, so the exact one
 * required depends on the requested status. A coarse gate runs first so an
 * unauthorised caller is rejected before the body is validated.
 */
const requireStatusPermission = (req, res, next) => {
  const permission = req.body.status === USER_STATUS.INACTIVE ? PERMISSIONS.USERS_DEACTIVATE : PERMISSIONS.USERS_ACTIVATE;
  return requirePermission(permission)(req, res, next);
};

router.patch(
  '/:id/status',
  requireAnyPermission(PERMISSIONS.USERS_ACTIVATE, PERMISSIONS.USERS_DEACTIVATE),
  validate(changeStatusRules),
  requireStatusPermission,
  userController.changeStatus
);

router.patch('/:id/role', requirePermission(PERMISSIONS.USERS_ASSIGN_ROLE), validate(changeRoleRules), userController.changeRole);

router.post(
  '/:id/reset-password',
  requirePermission(PERMISSIONS.USERS_RESET_PASSWORD),
  validate(resetPasswordRules),
  userController.resetPassword
);

module.exports = router;
