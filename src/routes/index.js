const express = require('express');
const customerRoutes = require('./customerRoutes');
const planRoutes = require('./planRoutes');
const subscriptionRoutes = require('./subscriptionRoutes');
const pbxDashboardRoutes = require('./pbxDashboardRoutes');
const recRateCardRoutes = require('./recRateCardRoutes');

const addonRoutes = require('./addonRoutes');
const paymentRoutes = require('./paymentRoutes');

const router = express.Router();

// API Routes (v1 & v2)
router.use('/api/customers', customerRoutes);
router.use('/api/plans', planRoutes);
router.use('/api/v1/plans', planRoutes);
router.use('/api/subscriptions', subscriptionRoutes);
router.use('/api/subscription-management', require('./subscriptionManagementRoutes'));
router.use('/api/customer-lifecycle', require('./customerLifecycleRoutes'));
router.use('/api/v2/subscriptions', subscriptionRoutes);
router.use('/api/v2/subscriptions/addons', addonRoutes);
router.use('/api/addons', addonRoutes);
router.use('/api/v2/wallets', paymentRoutes);
router.use('/api/pbx', pbxDashboardRoutes);
// Standard rate cards are retired in retail; only recording rate cards are supported:
router.use('/api/rec-rate-cards', recRateCardRoutes);

module.exports = router;
