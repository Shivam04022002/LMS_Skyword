'use strict';

const { body, param } = require('express-validator');

const roleIdRules = [param('id').isInt({ min: 1 }).withMessage('A valid role id is required')];

const updateRolePermissionsRules = [
  param('id').isInt({ min: 1 }).withMessage('A valid role id is required'),
  body('permissions').isArray().withMessage('permissions must be an array of permission names'),
  body('permissions.*').isString().trim().notEmpty().withMessage('Each permission must be a non-empty string')
];

module.exports = { roleIdRules, updateRolePermissionsRules };
