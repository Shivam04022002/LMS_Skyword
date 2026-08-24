'use strict';

/*
 * TEMPORARY: oneBulk historical collection migration utility.
 * Can be removed after historical collections are migrated — delete this
 * file, its controller, its service, its config, and the one line in
 * `routes/index.js` that mounts it. Normal collection routes are untouched.
 *
 * Gated on the existing `collections.import` permission rather than a new
 * one: whoever can already bulk-import collections can already do everything
 * oneBulk does, through the same allocation and posting rules. No new RBAC
 * surface is introduced for a temporary utility.
 */

const express = require('express');
const oneBulkController = require('../controllers/oneBulkController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const { uploadSpreadsheet } = require('../middleware/uploadMiddleware');
const { PERMISSIONS } = require('../config/permissions');

const router = express.Router();

router.use(authMiddleware);

router.get('/template', requirePermission(PERMISSIONS.COLLECTIONS_IMPORT), oneBulkController.downloadTemplate);

router.post(
  '/preview',
  requirePermission(PERMISSIONS.COLLECTIONS_IMPORT),
  uploadSpreadsheet('file'),
  oneBulkController.previewImport
);

router.post('/', requirePermission(PERMISSIONS.COLLECTIONS_IMPORT), uploadSpreadsheet('file'), oneBulkController.runImport);

module.exports = router;
