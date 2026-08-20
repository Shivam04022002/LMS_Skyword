'use strict';

const express = require('express');
const loanController = require('../controllers/loanController');
const loanImportController = require('../controllers/loanImportController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { uploadSpreadsheet } = require('../middleware/uploadMiddleware');
const { PERMISSIONS } = require('../config/permissions');
const { permissionForTransition } = require('../services/loanStatusService');
const {
  createLoanRules,
  updateLoanRules,
  changeStatusRules,
  loanIdRules,
  listLoansRules,
  previewRules
} = require('../validators/loanValidator');

const router = express.Router();

router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.LOANS_VIEW), validate(listLoansRules), loanController.listLoans);

// Declared before /:id so "preview" is never read as a loan id.
router.post('/preview', requireAnyPermission(PERMISSIONS.LOANS_CREATE, PERMISSIONS.LOANS_UPDATE), validate(previewRules), loanController.previewFinancials);

/*
 * Bulk import. Declared before /:id so "import" is never read as a loan id.
 *
 * The preview endpoint parses, validates and prices only; the import endpoint
 * is the one that writes, and it re-validates the workbook itself rather than
 * trusting anything the preview returned.
 */
router.get('/import/template', requirePermission(PERMISSIONS.LOANS_IMPORT), loanImportController.downloadTemplate);

router.post(
  '/import/preview',
  requirePermission(PERMISSIONS.LOANS_IMPORT),
  uploadSpreadsheet('file'),
  loanImportController.previewImport
);

router.post('/import', requirePermission(PERMISSIONS.LOANS_IMPORT), uploadSpreadsheet('file'), loanImportController.runImport);

router.get('/:id', requirePermission(PERMISSIONS.LOANS_VIEW), validate(loanIdRules), loanController.getLoan);

router.post('/', requirePermission(PERMISSIONS.LOANS_CREATE), validate(createLoanRules), loanController.createLoan);

router.put('/:id', requirePermission(PERMISSIONS.LOANS_UPDATE), validate(updateLoanRules), loanController.updateLoan);

/**
 * Each transition carries its own permission (activate / close / cancel), so the
 * exact one required depends on the target status. The coarse gate runs first,
 * rejecting an unauthorised caller before the body is validated.
 */
const requireTransitionPermission = (req, res, next) => {
  const permission = permissionForTransition(req.body.status);
  if (!permission) {
    return next();
  }
  return requirePermission(permission)(req, res, next);
};

router.patch(
  '/:id/status',
  requireAnyPermission(PERMISSIONS.LOANS_ACTIVATE, PERMISSIONS.LOANS_CLOSE, PERMISSIONS.LOANS_CANCEL),
  validate(changeStatusRules),
  requireTransitionPermission,
  loanController.changeStatus
);

// No DELETE route: loans are preserved, and cancellation is a status change.

module.exports = router;
