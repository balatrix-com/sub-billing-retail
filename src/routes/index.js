const express = require('express');
const customerRoutes = require('./customerRoutes');
const planRoutes = require('./planRoutes');
const subscriptionRoutes = require('./subscriptionRoutes');
const pbxDashboardRoutes = require('./pbxDashboardRoutes');
const rateCardRoutes = require('./rateCardRoutes');
const recRateCardRoutes = require('./recRateCardRoutes');

const addonRoutes = require('./addonRoutes');
const paymentRoutes = require('./paymentRoutes');

const router = express.Router();

// API Routes (v1 & v2)
router.use('/api/customers', customerRoutes);
router.use('/api/plans', planRoutes);
router.use('/api/v1/plans', planRoutes);
router.use('/api/subscriptions', subscriptionRoutes);
router.use('/api/v2/subscriptions', subscriptionRoutes);
router.use('/api/v2/subscriptions/addons', addonRoutes);
router.use('/api/addons', addonRoutes);
router.use('/api/v2/wallets', paymentRoutes);
router.use('/api/pbx', pbxDashboardRoutes);
router.use('/api/rate-cards', rateCardRoutes);
router.use('/api/v1/ratecards', rateCardRoutes);
router.use('/api/rec-rate-cards', recRateCardRoutes);

module.exports = router;
