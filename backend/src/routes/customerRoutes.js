'use strict';

const express = require('express');
const customerController = require('../controllers/customerController');
const customerImportController = require('../controllers/customerImportController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { uploadSpreadsheet } = require('../middleware/uploadMiddleware');
const { PERMISSIONS } = require('../config/permissions');
const { CUSTOMER_STATUS } = require('../config/customers');
const {
  createCustomerRules,
  updateCustomerRules,
  changeStatusRules,
  customerIdRules,
  listCustomersRules
} = require('../validators/customerValidator');

const router = express.Router();

// Everything below requires a valid JWT.
router.use(authMiddleware);

router.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate(listCustomersRules), customerController.listCustomers);

/*
 * Bulk import. Declared before /:id so "import" is never read as a customer id,
 * the same way loans declare /preview ahead of /:id.
 *
 * The preview endpoint parses and validates only; the import endpoint is the
 * one that writes, and it re-validates the workbook itself rather than trusting
 * anything the preview returned.
 */
/**
 * Excel download of the customer list, matching the caller's current search and
 * filters. Declared before /:id for the same reason the import routes are, so
 * "export" is never read as a customer id.
 *
 * TWO permissions, both required. `customers.view` is who may see this data at
 * all; `reports.export` is who may take it out of the system as a file. That
 * split already exists — a COLLECTOR holds reports.view but is deliberately
 * denied reports.export, because a downloaded file leaves the system's access
 * controls behind. Reusing it keeps one rule about downloads instead of two,
 * and adds no new permission to the catalogue.
 */
router.get(
  '/export',
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.REPORTS_EXPORT),
  validate(listCustomersRules),
  customerController.exportCustomers
);

router.get('/import/template', requirePermission(PERMISSIONS.CUSTOMERS_IMPORT), customerImportController.downloadTemplate);

router.post(
  '/import/preview',
  requirePermission(PERMISSIONS.CUSTOMERS_IMPORT),
  uploadSpreadsheet('file'),
  customerImportController.previewImport
);

router.post(
  '/import',
  requirePermission(PERMISSIONS.CUSTOMERS_IMPORT),
  uploadSpreadsheet('file'),
  customerImportController.runImport
);

router.get('/:id', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate(customerIdRules), customerController.getCustomer);

router.post('/', requirePermission(PERMISSIONS.CUSTOMERS_CREATE), validate(createCustomerRules), customerController.createCustomer);

router.put('/:id', requirePermission(PERMISSIONS.CUSTOMERS_UPDATE), validate(updateCustomerRules), customerController.updateCustomer);

/**
 * Activation and deactivation are distinct permissions, so the exact one
 * required depends on the requested status. The coarse gate runs first so an
 * unauthorised caller is rejected before the body is validated.
 */
const requireStatusPermission = (req, res, next) => {
  const permission =
    req.body.status === CUSTOMER_STATUS.INACTIVE ? PERMISSIONS.CUSTOMERS_DEACTIVATE : PERMISSIONS.CUSTOMERS_ACTIVATE;
  return requirePermission(permission)(req, res, next);
};

router.patch(
  '/:id/status',
  requireAnyPermission(PERMISSIONS.CUSTOMERS_ACTIVATE, PERMISSIONS.CUSTOMERS_DEACTIVATE),
  validate(changeStatusRules),
  requireStatusPermission,
  customerController.changeStatus
);

// No DELETE route: customers are deactivated, never physically removed.

module.exports = router;
