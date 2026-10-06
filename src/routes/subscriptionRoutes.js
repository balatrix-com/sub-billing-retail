const express = require('express');
const SubscriptionController = require('../controllers/subscriptionController');
const router = express.Router();

// Create a new subscription
router.post('/', SubscriptionController.createSubscription);

// Trigger all daily renewals manually
router.post('/trigger-renewals', SubscriptionController.triggerRenewals);

// Get all subscriptions
router.get('/', SubscriptionController.getAllSubscriptions);

// Get all subscriptions for a customer
router.get('/customer/:customerId', SubscriptionController.getCustomerSubscriptions);

// Get subscription by ID
router.get('/:subscriptionId', SubscriptionController.getSubscription);

// Update subscription
router.put('/:subscriptionId', SubscriptionController.updateSubscription);

// Cancel subscription
router.delete('/:subscriptionId', SubscriptionController.cancelSubscription);

// Renew a specific subscription manually
router.post('/:subscriptionId/renew', SubscriptionController.renewSubscription);

// Schedule or execute plan switch
router.post('/switch-plan', SubscriptionController.switchPlan);

module.exports = router;
