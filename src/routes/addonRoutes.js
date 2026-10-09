const express = require('express');
const AddonController = require('../controllers/AddonController');

const router = express.Router();

// ── Catalog Management ──────────────────────────────────────────
// Create or update a catalog add-on item
router.post('/catalog', AddonController.createAddonCatalogItem);

// Get all active catalog add-on items
router.get('/catalog', AddonController.getAddonCatalog);
router.get('/customer/:customerId/monitoring-entitlement', AddonController.getMonitoringEntitlement);

// Delete (soft-deactivate) a catalog add-on item
router.delete('/catalog/:addonId', AddonController.deleteAddonCatalogItem);

// ── Quoting & Purchase ──────────────────────────────────────────
router.post('/quote', AddonController.getAddonQuote);
router.post('/purchase', AddonController.purchaseAddon);

// ── Subscription Add-on Lifecycle ───────────────────────────────
// Get active add-ons for a subscription (by subscription UUID)
router.get('/subscription/:subscriptionId', AddonController.getSubscriptionAddons);

// Cancel an active subscription add-on (by subscription_addons row UUID)
router.delete('/subscription/:subscriptionAddonId', AddonController.cancelSubscriptionAddon);

module.exports = router;
