const express = require('express');
const SubscriptionController = require('../controllers/subscriptionController');
const router = express.Router();
const { serviceAuth } = require('../services/SubscriptionLifecycle');

// Create a new subscription
router.post('/', SubscriptionController.createSubscription);

// Trigger all daily renewals manually
router.post('/trigger-renewals', serviceAuth, SubscriptionController.triggerRenewals);

// Get all subscriptions
router.get('/', SubscriptionController.getAllSubscriptions);

// Get all subscriptions for a customer
router.get('/customer/:customerId', SubscriptionController.getCustomerSubscriptions);

// Get subscription by ID
router.get('/:subscriptionId', SubscriptionController.getSubscription);

// Update subscription
router.put('/:subscriptionId', (_req,res)=>res.status(410).json({success:false,message:'Use subscription-management lifecycle operations; direct subscription edits are disabled'}));

// Cancel subscription
router.delete('/:subscriptionId', serviceAuth, async (req,res)=>{
  try { const lifecycle=require('../services/SubscriptionLifecycle').createSubscriptionLifecycle(require('../config/database'));
    res.json({success:true,data:await lifecycle.transition(req.params.subscriptionId,'cancel',req.body?.actor_id)});
  } catch(e){res.status(e.statusCode || 500).json({success:false,message:e.message});}
});

// Renew a specific subscription manually
router.post('/:subscriptionId/renew', serviceAuth, SubscriptionController.renewSubscription);

// Schedule or execute plan switch
router.post('/switch-plan', (_req,res)=>res.status(410).json({success:false,message:'Plan switching is replaced by subscription activation and explicit asset reassignment'}));

module.exports = router;
