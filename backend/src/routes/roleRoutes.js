'use strict';

const express = require('express');
const roleController = require('../controllers/roleController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const { roleIdRules, updateRolePermissionsRules } = require('../validators/roleValidator');

const router = express.Router();

router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.ROLES_VIEW), roleController.listRoles);

router.get('/:id', requirePermission(PERMISSIONS.ROLES_VIEW), validate(roleIdRules), roleController.getRole);

router.put(
  '/:id/permissions',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate(updateRolePermissionsRules),
  roleController.updateRolePermissions
);

module.exports = router;
