'use strict';

const express = require('express');
const roleController = require('../controllers/roleController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const { PERMISSIONS } = require('../config/permissions');

const router = express.Router();

router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.PERMISSIONS_VIEW), roleController.listPermissions);

module.exports = router;
