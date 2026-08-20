'use strict';

const { body, param, query } = require('express-validator');
const { ROLE_VALUES, USER_STATUS_VALUES } = require('../config/roles');

// bcrypt silently truncates beyond 72 bytes, so the maximum is enforced here.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

const passwordRule = (field) =>
  body(field)
    .isString()
    .withMessage('Password is required')
    .bail()
    .isLength({ min: PASSWORD_MIN, max: PASSWORD_MAX })
    .withMessage(`Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`)
    .bail()
    .matches(/[A-Za-z]/)
    .withMessage('Password must contain at least one letter')
    .bail()
    .matches(/\d/)
    .withMessage('Password must contain at least one number');

const idParamRule = param('id').isInt({ min: 1 }).withMessage('A valid user id is required');

const listUsersRules = [
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  query('search').optional().isString().trim().isLength({ max: 120 }).withMessage('search is too long'),
  query('role').optional().isIn(ROLE_VALUES).withMessage(`role must be one of: ${ROLE_VALUES.join(', ')}`),
  query('status').optional().isIn(USER_STATUS_VALUES).withMessage(`status must be one of: ${USER_STATUS_VALUES.join(', ')}`),
  query('sortBy').optional().isIn(['name', 'email', 'status', 'createdAt', 'updatedAt']).withMessage('sortBy is not a sortable field'),
  query('sortOrder').optional().isIn(['ASC', 'DESC', 'asc', 'desc']).withMessage('sortOrder must be ASC or DESC')
];

const userIdRules = [idParamRule];

const createUserRules = [
  body('name').trim().notEmpty().withMessage('Name is required').bail().isLength({ max: 120 }).withMessage('Name is too long'),
  body('email').trim().notEmpty().withMessage('Email is required').bail().isEmail().withMessage('A valid email address is required').normalizeEmail(),
  passwordRule('password'),
  body('role').notEmpty().withMessage('Role is required').bail().isIn(ROLE_VALUES).withMessage(`Role must be one of: ${ROLE_VALUES.join(', ')}`),
  body('status').optional().isIn(USER_STATUS_VALUES).withMessage(`Status must be one of: ${USER_STATUS_VALUES.join(', ')}`)
];

const updateUserRules = [
  idParamRule,
  body('name').optional().trim().notEmpty().withMessage('Name cannot be empty').bail().isLength({ max: 120 }).withMessage('Name is too long'),
  body('email').optional().trim().isEmail().withMessage('A valid email address is required').normalizeEmail(),
  body('status').optional().isIn(USER_STATUS_VALUES).withMessage(`Status must be one of: ${USER_STATUS_VALUES.join(', ')}`),
  // Role and password have dedicated endpoints with their own permissions;
  // accepting them here would be a silent privilege-escalation path.
  body('role').not().exists().withMessage('Use PATCH /:id/role to change a role'),
  body('roleId').not().exists().withMessage('Use PATCH /:id/role to change a role'),
  body('password').not().exists().withMessage('Use POST /:id/reset-password to change a password')
];

const changeStatusRules = [
  idParamRule,
  body('status').notEmpty().withMessage('Status is required').bail().isIn(USER_STATUS_VALUES).withMessage(`Status must be one of: ${USER_STATUS_VALUES.join(', ')}`)
];

const changeRoleRules = [
  idParamRule,
  body('role').notEmpty().withMessage('Role is required').bail().isIn(ROLE_VALUES).withMessage(`Role must be one of: ${ROLE_VALUES.join(', ')}`)
];

const resetPasswordRules = [idParamRule, passwordRule('newPassword')];

module.exports = {
  listUsersRules,
  userIdRules,
  createUserRules,
  updateUserRules,
  changeStatusRules,
  changeRoleRules,
  resetPasswordRules
};
