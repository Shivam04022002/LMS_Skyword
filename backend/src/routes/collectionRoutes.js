'use strict';

const express = require('express');
const collectionController = require('../controllers/collectionController');
const collectionImportController = require('../controllers/collectionImportController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { uploadSpreadsheet } = require('../middleware/uploadMiddleware');
const { PERMISSIONS } = require('../config/permissions');
const {
  createCollectionRules,
  reverseCollectionRules,
  collectionIdRules,
  listCollectionsRules
} = require('../validators/collectionValidator');
const { receiptRules } = require('../validators/reportValidator');

const router = express.Router();

router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.COLLECTIONS_VIEW), validate(listCollectionsRules), collectionController.listCollections);

/*
 * Bulk import. Declared before /:id so "import" is never read as a collection
 * id. The preview parses, validates and plans the allocation only; the import
 * endpoint is the one that writes, and it re-validates the workbook and
 * re-plans every allocation against the live ledger.
 */
router.get('/import/template', requirePermission(PERMISSIONS.COLLECTIONS_IMPORT), collectionImportController.downloadTemplate);

router.post(
  '/import/preview',
  requirePermission(PERMISSIONS.COLLECTIONS_IMPORT),
  uploadSpreadsheet('file'),
  collectionImportController.previewImport
);

router.post(
  '/import',
  requirePermission(PERMISSIONS.COLLECTIONS_IMPORT),
  uploadSpreadsheet('file'),
  collectionImportController.runImport
);

router.get('/:id', requirePermission(PERMISSIONS.COLLECTIONS_VIEW), validate(collectionIdRules), collectionController.getCollection);

// Read-only receipt for an existing collection; needs its own permission.
router.get('/:id/receipt', requirePermission(PERMISSIONS.RECEIPTS_VIEW), validate(receiptRules), collectionController.getReceipt);

router.post('/', requirePermission(PERMISSIONS.COLLECTIONS_CREATE), validate(createCollectionRules), collectionController.createCollection);

/**
 * Reversal is a supervisory action with its own permission: a collector who can
 * post money cannot undo a posting.
 */
router.post(
  '/:id/reverse',
  requirePermission(PERMISSIONS.COLLECTIONS_REVERSE),
  validate(reverseCollectionRules),
  collectionController.reverseCollection
);

/**
 * There is deliberately no PUT and no DELETE. A posted collection is immutable
 * financial history; a correction is a reversal plus a replacement.
 */

module.exports = router;
