const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const WalletService = require('./WalletService');
const SubscriptionService = require('./SubscriptionService');
const FreeMinsService = require('./FreeMinsService');
const AssetService = require('./AssetService');
const cron = require('node-cron');
const WalletLockService = require('./WalletLockService');
const RecordingGateService = require('./RecordingGateService');

class BillingService {
  static initialize() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;

    cron.schedule('0 2 * * *', async () => {
      try {
        console.log('[BillingService] Running scheduled renewal billing...');
        const result = await this.processAllRenewals();
        console.log(`[BillingService] Renewal run complete. Processed: ${result.processed}, Failed: ${result.failed}`);
      } catch (err) {
        console.error('[BillingService] Scheduled renewal billing failed:', err.message);
      }
    });

    // Scheduled Free Minutes Expiry Purge (Daily at midnight)
    cron.schedule('0 0 * * *', async () => {
      try {
        console.log('[BillingService] Running scheduled free minutes expiry purge...');
        const stats = await FreeMinsService.processAllExpiries();
        console.log(`[BillingService] Expiry purge complete. Result: ${JSON.stringify(stats)}`);
      } catch (err) {
        console.error('[BillingService] Scheduled free minutes expiry purge failed:', err.message);
      }
    });

    console.log('[BillingService] Scheduler initialized (daily at 02:00)');
  }

  static async processSubscriptionRenewal(subscriptionId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Resolve subscription (handle both UUID and SUB-ID)
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId);
      const whereClause = isUuid ? 's.id = $1' : 's.subscription_id = $1';

      const subQuery = `
        SELECT s.*, p.amount, p.currency, p.validity_months
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
      const subscriptionUUID = subscription.id; // Always use the UUID for subsequent operations

      await WalletLockService.acquireCustomerWalletLock(client, subscription.customer_id);

      // Get customer's wallet
      const walletQuery = `
        SELECT fiat_balance, COALESCE(credit_limit, 0) as credit_limit,
               COALESCE(credit_used, 0) as credit_used
        FROM customer_wallets
        WHERE customer_id = $1
        FOR UPDATE;
      `;

      const walletResult = await client.query(walletQuery, [subscription.customer_id]);

      if (!walletResult.rows[0]) {
        throw new Error('Wallet not found');
      }

      const wallet = walletResult.rows[0];
      const planAmount = parseFloat(subscription.amount);
      
      // Calculate total addon amount (recurring only)
      const addonsQuery = `
        SELECT sa.*, a.price, a.addon_id
        FROM subscription_addons sa
        JOIN addons a ON sa.addon_id = a.addon_id
        WHERE sa.subscription_id = $1 
          AND sa.status = 'active'
          AND a.charge_type IN ('recurring', 'recurring_with_setup');
      `;
      const addonsResult = await client.query(addonsQuery, [subscriptionUUID]);
      const addons = addonsResult.rows;
      
      let totalAddonAmount = 0;
      for (const addon of addons) {
        totalAddonAmount += parseFloat(addon.price) * parseInt(addon.quantity || 1);
      }

      const totalChargeAmount = planAmount + totalAddonAmount;

      // Check if sufficient balance for Total (Plan + Addons)
      const fiatBalance = parseFloat(wallet.fiat_balance);
      const creditLimit = parseFloat(wallet.credit_limit);
      const creditUsed = parseFloat(wallet.credit_used);
      const availableBalance = fiatBalance + Math.max(0, creditLimit - creditUsed);

      if (availableBalance < totalChargeAmount) {
        throw new Error(`Insufficient balance for total renewal charge of ${totalChargeAmount}`);
      }

      const beforeBalance = fiatBalance;
      const fiatDebit = Math.min(beforeBalance, totalChargeAmount);
      const afterBalance = beforeBalance - fiatDebit;
      const afterCreditUsed = creditUsed + (totalChargeAmount - fiatDebit);

      // Update wallet
      const updateWalletQuery = `
        UPDATE customer_wallets
        SET fiat_balance = $2, credit_used = $3, last_updated = now()
        WHERE customer_id = $1;
      `;

      await client.query(updateWalletQuery, [subscription.customer_id, afterBalance, afterCreditUsed]);

      // Create invoice
      const invoiceId = uuidv4();
      const invoiceQuery = `
        INSERT INTO invoices (
          id, subscription_id, customer_id, amount, currency, 
          invoice_date, due_date, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *;
      `;

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);

      await client.query(invoiceQuery, [
        invoiceId,
        subscriptionUUID,
        subscription.customer_id,
        totalChargeAmount,
        subscription.currency,
        new Date(),
        dueDate,
        'paid'
      ]);

      // Record wallet transaction
      const txnQuery = `
        INSERT INTO wallet_transactions (
          id, customer_id, amount, currency, before_balance, after_balance,
          transaction_type, reference, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *;
      `;

      await client.query(txnQuery, [
        uuidv4(),
        subscription.customer_id,
        -totalChargeAmount,
        subscription.currency,
        beforeBalance,
        afterBalance,
        'subscription',
        `subscription_${subscriptionUUID}_renewal_bundle`,
        JSON.stringify({ 
            invoice_id: invoiceId,
            plan_amount: planAmount,
            addon_amount: totalAddonAmount,
            addon_count: addons.length
        })
      ]);

      // Renew subscription
      const now = new Date();
      const nextBilling = new Date(now.getTime() + subscription.validity_months * 30.44 * 24 * 60 * 60 * 1000);

      const renewQuery = `
        UPDATE subscriptions
        SET next_billing = $2, updated_at = now()
        WHERE id = $1
        RETURNING *;
      `;

      const renewResult = await client.query(renewQuery, [subscriptionUUID, nextBilling]);

      // Also renew all recurring addons with the same new billing date
      if (addons.length > 0) {
          const renewAddonsQuery = `
            UPDATE subscription_addons
            SET next_billing = $2, updated_at = now()
            WHERE subscription_id = $1 
              AND status = 'active'
              AND addon_id IN (
                  SELECT addon_id FROM addons 
                  WHERE charge_type IN ('recurring', 'recurring_with_setup')
              );
          `;
          await client.query(renewAddonsQuery, [subscriptionUUID, nextBilling]);
      }

      await client.query('COMMIT');

      await RecordingGateService.sync(subscription.customer_id, {
        fiat_balance: afterBalance,
        credit_limit: creditLimit,
        credit_used: afterCreditUsed
      });

      // Reactivate any suspended assets now that we are successfully renewed
      await AssetService.reactivateAssetsForSubscription(subscriptionUUID);

      // Ensure status is active in DB as well
      await client.query('UPDATE subscriptions SET status = \'active\', updated_at = now() WHERE id = $1', [subscriptionUUID]);

      return {
        success: true,
        subscription: renewResult.rows[0],
        invoice_id: invoiceId,
        total_charged: totalChargeAmount,
        plan_amount: planAmount,
        addon_amount: totalAddonAmount
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to process renewal: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Process all subscriptions due for renewal (cron job)
   */
  static async processAllRenewals() {
    try {
      const subscriptions = await SubscriptionService.getSubscriptionsDueForRenewal();
      const results = [];
      const failures = [];

      for (const subscription of subscriptions) {
        try {
          const result = await this.processSubscriptionRenewal(subscription.id);
          results.push(result);
        } catch (err) {
          // If renewal fails due to balance, mark subscription as suspended and assets as inactive
          if (err.message.includes('Insufficient balance')) {
            console.log(`[BillingService] Subscription ${subscription.id} failed renewal due to balance. Suspending...`);
            await pool.query('UPDATE subscriptions SET status = \'suspended\', updated_at = now() WHERE id = $1', [subscription.id]);
            await AssetService.suspendAssetsForSubscription(subscription.id);
          }

          failures.push({
            subscription_id: subscription.id,
            error: err.message
          });
        }
      }

      return {
        processed: results.length,
        failed: failures.length,
        results,
        failures
      };
    } catch (err) {
      throw new Error(`Failed to process renewals: ${err.message}`);
    }
  }

  /**
   * Generate invoice for a subscription
   */
  static async generateInvoice(subscriptionId) {
    try {
      // Get subscription details
      const subQuery = `
        SELECT s.*, p.amount, p.currency, p.name as plan_name
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.plan_id
        WHERE s.id = $1;
      `;

      const subResult = await pool.query(subQuery, [subscriptionId]);

      if (!subResult.rows[0]) {
        throw new Error('Subscription not found');
      }

      const subscription = subResult.rows[0];
      const invoiceId = uuidv4();

      // Create invoice
      const invoiceQuery = `
        INSERT INTO invoices (
          id, subscription_id, customer_id, amount, currency,
          invoice_date, due_date, description, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `;

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);

      const result = await pool.query(invoiceQuery, [
        invoiceId,
        subscriptionId,
        subscription.customer_id,
        subscription.amount,
        subscription.currency,
        new Date(),
        dueDate,
        `Invoice for ${subscription.plan_name}`,
        'pending'
      ]);

      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to generate invoice: ${err.message}`);
    }
  }

  /**
   * Get billing summary for a customer
   */
  static async getBillingSummary(customerId) {
    try {
      const query = `
        SELECT
          (SELECT COUNT(*) FROM subscriptions WHERE customer_id = $1 AND status = 'active') as active_subscriptions,
          (SELECT SUM(amount) FROM wallet_transactions WHERE customer_id = $1 AND transaction_type = 'subscription') as total_charged,
          (SELECT SUM(amount) FROM payments WHERE customer_id = $1 AND amount > 0) as total_payments,
          (SELECT fiat_balance FROM customer_wallets WHERE customer_id = $1) as current_balance,
          (SELECT free_seconds FROM customer_wallets WHERE customer_id = $1) as free_mins_balance;
      `;

      const result = await pool.query(query, [customerId]);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to get billing summary: ${err.message}`);
    }
  }

  /**
   * Calculate amount due for a subscription
   */
  static async calculateAmountDue(subscriptionId) {
    try {
      const query = `
        SELECT s.*, p.amount, p.currency
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.plan_id
        WHERE s.id = $1;
      `;

      const result = await pool.query(query, [subscriptionId]);

      if (!result.rows[0]) {
        throw new Error('Subscription not found');
      }

      const subscription = result.rows[0];

      return {
        subscription_id: subscriptionId,
        amount: subscription.amount,
        currency: subscription.currency,
        plan_id: subscription.plan_id,
        validity_months: subscription.validity_months
      };
    } catch (err) {
      throw new Error(`Failed to calculate amount: ${err.message}`);
    }
  }
}

module.exports = BillingService;
