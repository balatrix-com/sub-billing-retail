const express = require('express');
const PBXDashboardController = require('../controllers/PBXDashboardController');

const router = express.Router();

// GET /api/pbx/balance/:customerId
router.get('/balance/:customerId', PBXDashboardController.getCustomerBalance);

// GET /api/pbx/transactions/:customerId
router.get('/transactions/:customerId', PBXDashboardController.getTransactions);

// GET /api/pbx/all
router.get('/all', PBXDashboardController.getAllBalances);

// GET /api/pbx/subscription/:customerId
router.get('/subscription/:customerId', PBXDashboardController.getSubscriptionDetails);

// GET /api/pbx/cards/:customerId
router.get('/cards/:customerId', PBXDashboardController.getPaymentMethods);

// GET /api/pbx/cdrs (Fetch all CDRs in ascending order)
router.get('/cdrs', PBXDashboardController.getAllCDRs);

// GET /api/pbx/cdrs/:customerId
router.get('/cdrs/:customerId', PBXDashboardController.getCustomerCDRs);

// POST /api/pbx/sync-assets/:subscriptionId
router.post('/sync-assets/:subscriptionId', PBXDashboardController.syncAssets);
router.post('/unassign-assets', PBXDashboardController.unassignAssets);
router.get('/subscription-assets/:subscriptionId', PBXDashboardController.getSubscriptionAssets);

// GET /api/pbx/assets/:customerId - Get all assets (TFNs, DIDs, Extensions) for a customer
router.get('/assets/:customerId', PBXDashboardController.getCustomerAssets);

module.exports = router;
