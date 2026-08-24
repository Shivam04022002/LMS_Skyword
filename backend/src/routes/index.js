'use strict';

const express = require('express');
const healthRoutes = require('./healthRoutes');
const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');
const roleRoutes = require('./roleRoutes');
const permissionRoutes = require('./permissionRoutes');
const customerRoutes = require('./customerRoutes');
const loanPartyRoutes = require('./loanPartyRoutes');
const loanRoutes = require('./loanRoutes');
const emiRoutes = require('./emiRoutes');
const collectionRoutes = require('./collectionRoutes');
const routeRoutes = require('./routeRoutes');
const demandRoutes = require('./demandRoutes');
const reportRoutes = require('./reportRoutes');
const dashboardRoutes = require('./dashboardRoutes');
// TEMPORARY: oneBulk historical collection migration utility. Remove this
// require and the router.use() line below to remove the feature entirely.
const oneBulkRoutes = require('./oneBulkRoutes');
const collectionController = require('../controllers/collectionController');
const authMiddleware = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../config/permissions');
const { loanSummaryRules } = require('../validators/collectionValidator');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);

// Administration surface. Each route declares its own required permission.
router.use('/admin/users', userRoutes);
router.use('/admin/roles', roleRoutes);
router.use('/admin/permissions', permissionRoutes);
router.use('/admin/customers', customerRoutes);

// The nested parties sub-resource is mounted before the loan resource so its
// more specific path always wins.
router.use('/admin/loans/:loanId/parties', loanPartyRoutes);
router.use('/admin/loans/:loanId/emis', emiRoutes);

// Payment position of a single loan; lives under the loan it describes.
router.get(
  '/admin/loans/:loanId/collection-summary',
  authMiddleware,
  requirePermission(PERMISSIONS.COLLECTIONS_VIEW),
  validate(loanSummaryRules),
  collectionController.getLoanSummary
);

router.use('/admin/loans', loanRoutes);
router.use('/admin/collections', collectionRoutes);
router.use('/admin/routes', routeRoutes);
router.use('/admin/demand', demandRoutes);
router.use('/admin/reports', reportRoutes);
router.use('/admin/dashboard', dashboardRoutes);
// TEMPORARY: oneBulk historical collection migration utility. See the require above.
router.use('/admin/one-bulk', oneBulkRoutes);

module.exports = router;
