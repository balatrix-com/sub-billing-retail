const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const FreeMinsService = require('./FreeMinsService');
const WalletLockService = require('./WalletLockService');

class SubscriptionService {
  /**
   * Create a subscription for a customer
   */
  static async createSubscription(customerId, planId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get plan info
      const planQuery = 'SELECT * FROM plans WHERE plan_id = $1;';
      const planResult = await client.query(planQuery, [planId]);

      if (!planResult.rows[0]) {
        throw new Error('Plan not found');
      }

      const plan = planResult.rows[0];
      const now = new Date();
      const nextBilling = new Date(now.getTime() + plan.validity_months * 30.44 * 24 * 60 * 60 * 1000);

      // Create subscription
      const subQuery = `
        INSERT INTO subscriptions (
          id, customer_id, plan_id, status, start_date, next_billing
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `;

      const subResult = await client.query(subQuery, [
        uuidv4(),
        customerId,
        planId,
        'active',
        now,
        nextBilling
      ]);

      const subscription = subResult.rows[0];

      await WalletLockService.acquireCustomerWalletLock(client, subscription.customer_id);

      // Grant free minutes for the subscription
      if (plan.free_mins > 0) {
        const freeMinsInSecs = plan.free_mins * 60;
        const grantQuery = `
          INSERT INTO free_mins_grants (
            id, customer_id, source_type, source_id, granted_secs, 
            valid_from, valid_to, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *;
        `;

        await client.query(grantQuery, [
          uuidv4(),
          customerId,
          'plan',
          planId,
          freeMinsInSecs,
          now,
          nextBilling,
          'active'
        ]);

        // Update wallet with free seconds
        const walletLockQuery = `
          SELECT free_seconds, version
          FROM customer_wallets
          WHERE customer_id = $1
          FOR UPDATE;
        `;
        const walletRows = await client.query(walletLockQuery, [customerId]);

        if (!walletRows.rows[0]) {
          throw new Error('Wallet not found');
        }

        const currentFreeSeconds = Number(walletRows.rows[0].free_seconds || 0);
        const nextFreeSeconds = currentFreeSeconds + freeMinsInSecs;
        const walletVersion = walletRows.rows[0].version;

        const walletQuery = `
          UPDATE customer_wallets
          SET free_seconds = $2, version = version + 1, last_updated = now()
          WHERE customer_id = $1 AND version = $3;
        `;

        const walletUpdate = await client.query(walletQuery, [customerId, nextFreeSeconds, walletVersion]);
        if (walletUpdate.rowCount === 0) {
          throw new Error('Wallet version mismatch - concurrent modification detected');
        }

        // Record the transaction
        const txnQuery = `
          INSERT INTO free_mins_transactions (
            id, customer_id, amount_secs, transaction_type, reference
          ) VALUES ($1, $2, $3, $4, $5);
        `;

        await client.query(txnQuery, [
          uuidv4(),
          customerId,
          freeMinsInSecs,
          'grant',
          `subscription_${subscription.id}_created`
        ]);
      }

      await client.query('COMMIT');
      return subscription;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to create subscription: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Renew a subscription
   */
  static async renewSubscription(subscriptionId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get subscription
      const subQuery = `
        SELECT s.*, p.validity_months, p.free_mins
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.plan_id
        WHERE s.id = $1
        FOR UPDATE;
      `;

      const subResult = await client.query(subQuery, [subscriptionId]);

      if (!subResult.rows[0]) {
        throw new Error('Subscription not found');
      }

      const subscription = subResult.rows[0];

      await WalletLockService.acquireCustomerWalletLock(client, subscription.customer_id);
      const now = new Date();
      const nextBilling = new Date(now.getTime() + subscription.validity_months * 30.44 * 24 * 60 * 60 * 1000);

      // Update next_billing
      const updateQuery = `
        UPDATE subscriptions
        SET next_billing = $2, updated_at = now()
        WHERE id = $1
        RETURNING *;
      `;

      const updateResult = await client.query(updateQuery, [subscriptionId, nextBilling]);

      // Grant new free minutes
      if (subscription.free_mins > 0) {
        const freeMinsInSecs = subscription.free_mins * 60;

        const grantQuery = `
          INSERT INTO free_mins_grants (
            id, customer_id, source_type, source_id, granted_secs,
            valid_from, valid_to, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *;
        `;

        await client.query(grantQuery, [
          uuidv4(),
          subscription.customer_id,
          'plan',
          subscription.plan_id,
          freeMinsInSecs,
          now,
          nextBilling,
          'active'
        ]);

        // Update wallet
        const walletLockQuery = `
          SELECT free_seconds, version
          FROM customer_wallets
          WHERE customer_id = $1
          FOR UPDATE;
        `;
        const walletRows = await client.query(walletLockQuery, [subscription.customer_id]);

        if (!walletRows.rows[0]) {
          throw new Error('Wallet not found');
        }

        const currentFreeSeconds = Number(walletRows.rows[0].free_seconds || 0);
        const nextFreeSeconds = currentFreeSeconds + freeMinsInSecs;
        const walletVersion = walletRows.rows[0].version;

        const walletQuery = `
          UPDATE customer_wallets
          SET free_seconds = $2, version = version + 1, last_updated = now()
          WHERE customer_id = $1 AND version = $3;
        `;

        const walletUpdate = await client.query(walletQuery, [subscription.customer_id, nextFreeSeconds, walletVersion]);
        if (walletUpdate.rowCount === 0) {
          throw new Error('Wallet version mismatch - concurrent modification detected');
        }

        // Record transaction
        const txnQuery = `
          INSERT INTO free_mins_transactions (
            id, customer_id, amount_secs, transaction_type, reference
          ) VALUES ($1, $2, $3, $4, $5);
        `;

        await client.query(txnQuery, [
          uuidv4(),
          subscription.customer_id,
          freeMinsInSecs,
          'grant',
          `subscription_${subscriptionId}_renewed`
        ]);
      }

      await client.query('COMMIT');
      return updateResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to renew subscription: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Cancel a subscription with prorated refund
   */
  static async cancelSubscription(subscriptionId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Fetch the subscription with its plan and price
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId);
      const whereClause = isUuid ? 's.id = $1' : 's.subscription_id = $1';

      const subQuery = `
        SELECT s.*, p.amount as plan_amount, p.currency, p.validity_months
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.plan_id
        WHERE ${whereClause}
        FOR UPDATE;
      `;
      const subResult = await client.query(subQuery, [subscriptionId]);

      if (!subResult.rows[0]) {
        throw new Error('Subscription not found');
      }

      const subscription = subResult.rows[0];

      if (subscription.status === 'cancelled') {
        throw new Error('Subscription is already cancelled');
      }

      // 2. Fetch any addons for this subscription to calculate total amount paid
      const addonsQuery = `
        SELECT sa.*, a.price, a.setup_fee, a.addon_type
        FROM subscription_addons sa
        JOIN addons a ON sa.addon_id = a.addon_id
        WHERE sa.subscription_id = $1 AND sa.status = 'active';
      `;
      const addonsResult = await client.query(addonsQuery, [subscription.id]);
      const addons = addonsResult.rows;

      // 3. Calculate prorated refund based on time remaining
      const now = new Date();
      const nextBilling = new Date(subscription.next_billing);
      const lastBilling = new Date(subscription.next_billing);
      lastBilling.setMonth(lastBilling.getMonth() - Number(subscription.validity_months));

      let refundAmount = 0;

      // Only refund if there is time remaining
      if (nextBilling > now && now >= lastBilling) {
        const totalCycleMs = nextBilling.getTime() - lastBilling.getTime();
        const remainingMs = nextBilling.getTime() - now.getTime();
        const remainingFraction = remainingMs / totalCycleMs;

        // Base plan cost
        const planCost = Number(subscription.plan_amount || 0);
        let totalRefundable = planCost;

        // Add recurring addon costs (do not refund setup fees)
        for (const addon of addons) {
          totalRefundable += Number(addon.total_recurring_paid || 0);
        }

        // Calculate prorated
        refundAmount = totalRefundable * remainingFraction;
        refundAmount = Math.round(refundAmount * 100) / 100; // Round to 2 decimals
      }

      // 4. Refund to wallet if amount > 0
      let updatedWalletBalance = null;
      if (refundAmount > 0) {
        const lockedWalletQuery = `
          SELECT w.fiat_balance, w.version
          FROM customer_wallets w
          WHERE w.customer_id = $1
          FOR UPDATE;
        `;
        const walletResult = await client.query(lockedWalletQuery, [subscription.customer_id]);

        if (walletResult.rows[0]) {
          const wallet = walletResult.rows[0];
          const beforeBalance = Number(wallet.fiat_balance);
          const afterBalance = beforeBalance + refundAmount;

          // Update Wallet
          await client.query(`
            UPDATE customer_wallets
            SET fiat_balance = $1, last_updated = now(), version = version + 1
            WHERE customer_id = $2
          `, [afterBalance, subscription.customer_id]);

          // Record Txn
          await client.query(`
            INSERT INTO wallet_transactions (
              id, customer_id, amount, currency, before_balance, after_balance,
              transaction_type, reference, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          `, [
            uuidv4(),
            subscription.customer_id,
            refundAmount, // Positive for refund
            subscription.currency,
            beforeBalance,
            afterBalance,
            'refund',
            `REFUND-SUB-${Date.now()}`,
            JSON.stringify({
              subscription_id: subscription.subscription_id,
              reason: 'Prorated cancellation refund',
              total_refundable: refundAmount
            })
          ]);

          updatedWalletBalance = afterBalance;
        }
      }

      // 5. Update subscription status
      const updateQuery = `
        UPDATE subscriptions
        SET status = 'cancelled', updated_at = now()
        WHERE id = $1
        RETURNING *;
      `;
      const result = await client.query(updateQuery, [subscription.id]);

      // Also cancel any active addons
      await client.query(`
        UPDATE subscription_addons
        SET status = 'cancelled'
        WHERE subscription_id = $1
      `, [subscription.id]);

      // 6. Nullify free minutes granted by this subscription for future usage
      // We set valid_to to Now so they instantly expire
      await client.query(`
        UPDATE free_mins_grants
        SET status = 'cancelled', valid_to = now()
        WHERE customer_id = $1 AND valid_to > now() 
        AND (source_id = $2 OR source_id IN (SELECT addon_id FROM subscription_addons WHERE subscription_id = $3))
      `, [subscription.customer_id, subscription.plan_id, subscription.id]);

      await client.query('COMMIT');

      const cancelledSub = result.rows[0];
      cancelledSub.refunded_fiat = refundAmount;

      // 7. Emit Teardown Event
      const EventService = require('./EventService');
      EventService.emit('subscription.cancelled', {
        subscription_id: cancelledSub.subscription_id,
        subscription_row_id: cancelledSub.id,
        customer_id: cancelledSub.customer_id
      });

      return cancelledSub;
    } catch (err) {
      await client.query('ROLLBACK');
      if (!err.statusCode) err.statusCode = 500;
      throw new Error(`Failed to cancel subscription: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get subscriptions due for renewal
   */
  static async getSubscriptionsDueForRenewal() {
    const query = `
      SELECT s.* FROM subscriptions s
      WHERE s.status = 'active'
        AND s.next_billing <= now()
      ORDER BY s.next_billing ASC;
        `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch subscriptions due for renewal: ${err.message} `);
    }
  }

  /**
   * Get subscription details with plan info
   */
  static async getSubscriptionDetails(subscriptionId) {
    const query = `
      SELECT s.*, p.* FROM subscriptions s
      JOIN plans p ON s.plan_id = p.plan_id
      WHERE s.id = $1;
        `;

    try {
      const result = await pool.query(query, [subscriptionId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch subscription: ${err.message} `);
    }
  }

  /**
   * Get customer's active subscriptions
   */
  static async getActiveSubscriptions(customerId) {
    const query = `
      SELECT s.*, p.* FROM subscriptions s
      JOIN plans p ON s.plan_id = p.plan_id
      WHERE s.customer_id = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC;
        `;

    try {
      const result = await pool.query(query, [customerId]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch active subscriptions: ${err.message} `);
    }
  }

  /**
   * Get all subscriptions for a customer
   */
  static async getCustomerSubscriptions(customerId) {
    const query = `
      SELECT s.*, p.* FROM subscriptions s
      JOIN plans p ON s.plan_id = p.plan_id
      WHERE s.customer_id = $1
      ORDER BY s.created_at DESC;
        `;

    try {
      const result = await pool.query(query, [customerId]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch subscriptions: ${err.message} `);
    }
  }
}

module.exports = SubscriptionService;
