const SubscriptionModel = require('../models/Subscription');
const SubscriptionService = require('../services/SubscriptionService');
const BillingService = require('../services/BillingService');

class SubscriptionController {
  // Create a new subscription
  static async createSubscription(req, res) {
    try {
      const {
        customer_id,
        plan_id,
        status,
        addons = [],
        override_balance_check = false
      } = req.body;

      const subscription = await SubscriptionModel.create({
        customer_id,
        plan_id,
        status: status || 'active',
        addons,
        override_balance_check
      });

      res.status(201).json({
        success: true,
        message: 'Subscription created successfully',
        data: subscription
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Manually trigger the daily renewal process (Debug/Admin endpoint)
  static async triggerRenewals(req, res) {
    try {
      const results = await BillingService.processAllRenewals();

      res.status(200).json({
        success: true,
        message: 'Manual renewal process triggered successfully',
        data: {
          successful_renewals: results.processed,
          failed_renewals: results.failed,
          details: {
            results: results.results,
            failures: results.failures
          }
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to process renewals',
        error: error.message
      });
    }
  }

  // Get subscription by ID
  static async getSubscription(req, res) {
    try {
      const { subscriptionId } = req.params;
      const subscription = await SubscriptionModel.findById(subscriptionId);

      if (!subscription) {
        return res.status(404).json({
          success: false,
          message: 'Subscription not found'
        });
      }

      res.status(200).json({
        success: true,
        data: subscription
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get all subscriptions
  static async getAllSubscriptions(req, res) {
    try {
      const subscriptions = await SubscriptionModel.getAll();

      res.status(200).json({
        success: true,
        data: subscriptions
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get subscriptions by customer
  static async getCustomerSubscriptions(req, res) {
    try {
      const { customerId } = req.params;
      const subscriptions = await SubscriptionModel.findByCustomerId(customerId);

      res.status(200).json({
        success: true,
        data: subscriptions
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Update subscription
  static async updateSubscription(req, res) {
    try {
      const { subscriptionId } = req.params;
      const updateData = req.body;

      const subscription = await SubscriptionModel.update(subscriptionId, updateData);

      if (!subscription) {
        return res.status(404).json({
          success: false,
          message: 'Subscription not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Subscription updated successfully',
        data: subscription
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Cancel subscription
  static async cancelSubscription(req, res) {
    try {
      const { subscriptionId } = req.params;

      const subscription = await SubscriptionService.cancelSubscription(subscriptionId);

      if (!subscription) {
        return res.status(404).json({
          success: false,
          message: 'Subscription not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Subscription cancelled successfully',
        data: subscription
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Manually renew a specific subscription
  static async renewSubscription(req, res) {
    try {
      const { subscriptionId } = req.params;

      const renewalResult = await BillingService.processSubscriptionRenewal(subscriptionId, req.body.operation_key);

      res.status(200).json({
        success: true,
        message: 'Subscription renewed successfully',
        data: renewalResult
      });
    } catch (error) {
      res.status(error.message.includes('Insufficient balance') ? 400 : 500).json({
        success: false,
        message: 'Failed to renew subscription',
        error: error.message
      });
    }
  }

  // Schedule or Execute Plan Switch
  static async switchPlan(req, res) {
    const pool = require('../config/database');
    try {
      const { customer_id, target_plan_id, execute_on_expiration = true } = req.body;
      if (!customer_id || !target_plan_id) {
        return res.status(400).json({ success: false, message: 'customer_id and target_plan_id are required' });
      }

      // Check target plan exists
      const planRes = await pool.query(`SELECT * FROM plans WHERE plan_id = $1;`, [target_plan_id]);
      if (!planRes.rows[0]) {
        return res.status(404).json({ success: false, message: 'Target plan not found' });
      }

      const subRes = await pool.query(
        `SELECT * FROM subscriptions WHERE customer_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1;`,
        [customer_id]
      );
      const subscription = subRes.rows[0];
      if (!subscription) {
        // Automatically create initial subscription if customer has no active subscription
        const newSub = await SubscriptionModel.create({
          customer_id,
          plan_id: target_plan_id,
          status: 'active',
          override_balance_check: req.body.override_balance_check === true
        });
        return res.status(200).json({
          success: true,
          message: `Subscription created and assigned to plan ${target_plan_id}.`,
          data: newSub
        });
      }

      const targetPlan = planRes.rows[0];

      if (execute_on_expiration) {
        const switchTime = subscription.next_billing || subscription.end_date || new Date();
        await pool.query(
          `UPDATE subscriptions SET target_plan_id = $1, scheduled_switch_at = $2, updated_at = NOW() WHERE id = $3;`,
          [target_plan_id, switchTime, subscription.id]
        );

        return res.status(200).json({
          success: true,
          message: `Plan switch to ${target_plan_id} scheduled for cycle end (${new Date(switchTime).toISOString()}).`,
          data: {
            customer_id,
            subscription_id: subscription.subscription_id,
            current_plan_id: subscription.plan_id,
            target_plan_id,
            scheduled_switch_at: switchTime
          }
        });
      } else {
        // Immediate switch logic
        await pool.query(
          `UPDATE subscriptions SET plan_id = $1, rate_card_id = NULL, base_plan_price = $2, updated_at = NOW() WHERE id = $3;`,
          [target_plan_id, targetPlan.amount, subscription.id]
        );

        return res.status(200).json({
          success: true,
          message: `Plan switched immediately to ${target_plan_id}.`,
          data: {
            customer_id,
            subscription_id: subscription.subscription_id,
            new_plan_id: target_plan_id
          }
        });
      }
    } catch (error) {
      res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }
  }
}

module.exports = SubscriptionController;
