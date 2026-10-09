const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const EventService = require('../services/EventService');
const WalletLockService = require('../services/WalletLockService');
const RecordingGateService = require('../services/RecordingGateService');
const { isPlanLimitedAddon } = require('../services/PlanLimitedAddons');

class Subscription {
  static generateTxnRef(prefix) {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }

  static parseAddonFreeMins(addonMetadata) {
    if (!addonMetadata || typeof addonMetadata !== 'object') {
      return 0;
    }

    const mins = Number(addonMetadata.free_mins || 0);
    return Number.isFinite(mins) && mins > 0 ? mins : 0;
  }

  static async generateReadableSubscriptionId(dbClient = pool) {
    const query = `
      SELECT subscription_id
      FROM subscriptions
      WHERE subscription_id ~ '^SUB-[0-9]+'
      ORDER BY CAST(SUBSTRING(subscription_id FROM 5 FOR 8) AS INTEGER) DESC
      LIMIT 1;
    `;

    try {
      const result = await dbClient.query(query);
      let nextNumber = 2601;

      if (result.rows.length > 0 && result.rows[0].subscription_id) {
        const match = result.rows[0].subscription_id.match(/^SUB-(\d+)/);
        if (match && match[1]) {
          const currentNumber = parseInt(match[1], 10);
          if (!Number.isNaN(currentNumber)) {
            nextNumber = currentNumber + 1;
          }
        }
      }
      const randSuffix = Math.floor(Math.random() * 900 + 100);
      return `SUB-${nextNumber}-${randSuffix}`;
    } catch (err) {
      return `SUB-${Date.now()}`;
    }
  }

  static async create(subscriptionData) {
    const {
      customer_id,
      plan_id,
      status = 'active',
      addons = [],
      override_balance_check = false
    } = subscriptionData;

    if (!customer_id || !plan_id) {
      const error = new Error('customer_id and plan_id are required');
      error.statusCode = 400;
      throw error;
    }

    if (!Array.isArray(addons)) {
      const error = new Error('addons must be an array');
      error.statusCode = 400;
      throw error;
    }

    const subscriptionRowId = uuidv4();
    const readableSubscriptionId = await this.generateReadableSubscriptionId();
    const now = new Date();
    const normalizedAddons = addons.map((addon) => ({
      addon_id: addon.addon_id,
      quantity: Number(addon.quantity || 1)
    }));

    for (const addon of normalizedAddons) {
      if (!addon.addon_id || !Number.isInteger(addon.quantity) || addon.quantity <= 0) {
        const error = new Error('each addon must include addon_id and positive integer quantity');
        error.statusCode = 400;
        throw error;
      }
    }

    try {
      const planQuery = 'SELECT * FROM plans WHERE plan_id = $1;';
      const planResult = await pool.query(planQuery, [plan_id]);
      if (!planResult.rows[0]) {
        const error = new Error('Plan not found');
        error.statusCode = 404;
        throw error;
      }

      const plan = planResult.rows[0];
      const nextBilling = new Date(now);
      nextBilling.setMonth(nextBilling.getMonth() + Number(plan.validity_months));

      let addonRows = [];
      if (normalizedAddons.length > 0) {
        const addonIds = normalizedAddons.map((addon) => addon.addon_id);
        const addonQuery = 'SELECT * FROM addons WHERE addon_id = ANY($1::text[]) AND is_active = true;';
        const addonResult = await pool.query(addonQuery, [addonIds]);
        addonRows = addonResult.rows;

        const foundAddonIds = new Set(addonRows.map((row) => row.addon_id));
        const missing = addonIds.filter((id) => !foundAddonIds.has(id));
        if (missing.length > 0) {
          const error = new Error(`Addon not found or inactive: ${missing.join(', ')}`);
          error.statusCode = 400;
          throw error;
        }
        if (addonRows.some(isPlanLimitedAddon)) {
          const error = new Error('Numbers are controlled by the plan, not add-ons');
          error.statusCode = 400;
          throw error;
        }
      }

      const addonById = new Map(addonRows.map((addon) => [addon.addon_id, addon]));

      const planAmount = Number(plan.amount || 0);
      let totalCost = planAmount;
      const totalFreeSeconds = 0;

      const addonCostBreakdown = normalizedAddons.map((item) => {
        const addon = addonById.get(item.addon_id);
        const recurringTotal = Number(addon.price || 0) * item.quantity;
        const setupTotal = Number(addon.setup_fee || 0) * item.quantity;
        const lineTotal = recurringTotal + setupTotal;
        totalCost += lineTotal;

        const addonFreeSeconds = 0;

        return {
          addon,
          quantity: item.quantity,
          recurringTotal,
          setupTotal,
          lineTotal,
          addonFreeSeconds
        };
      });

      // Pre-check without lock/transaction for fast fail
      const precheckQuery = `
        SELECT w.customer_id, w.fiat_balance, COALESCE(w.credit_limit, 0) AS credit_limit,
               COALESCE(w.credit_used, 0) AS credit_used, w.version, c.currency
        FROM customer_wallets w
        JOIN customers c ON c.customer_id = w.customer_id
        WHERE w.customer_id = $1;
      `;
      const precheckResult = await pool.query(precheckQuery, [customer_id]);

      if (!precheckResult.rows[0]) {
        const error = new Error('Customer wallet not found');
        error.statusCode = 404;
        throw error;
      }

      const preWallet = precheckResult.rows[0];
      const preBalance = Number(preWallet.fiat_balance);
      const creditLimit = Number(preWallet.credit_limit || 0);
      const preCreditUsed = Number(preWallet.credit_used || 0);
      const availableBalance = preBalance + Math.max(0, creditLimit - preCreditUsed);

      if (!override_balance_check && availableBalance < totalCost) {
        const error = new Error('Insufficient wallet balance and credit limit to purchase subscription');
        error.statusCode = 400;
        throw error;
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await WalletLockService.acquireCustomerWalletLock(client, customer_id);

        const lockedWalletQuery = `
          SELECT w.customer_id, w.currency, w.fiat_balance, w.free_seconds,
                 COALESCE(w.credit_limit, 0) AS credit_limit,
                 COALESCE(w.credit_used, 0) AS credit_used, w.version
          FROM customer_wallets w
          WHERE w.customer_id = $1
          FOR UPDATE;
        `;
        const lockedWalletResult = await client.query(lockedWalletQuery, [customer_id]);

        if (!lockedWalletResult.rows[0]) {
          const error = new Error('Customer wallet not found');
          error.statusCode = 404;
          throw error;
        }

        const wallet = lockedWalletResult.rows[0];
        const beforeBalance = Number(wallet.fiat_balance);
        const beforeFreeSeconds = Number(wallet.free_seconds);
        const lockedCreditLimit = Number(wallet.credit_limit || 0);
        const beforeCreditUsed = Number(wallet.credit_used || 0);
        const availableBalance = beforeBalance + Math.max(0, lockedCreditLimit - beforeCreditUsed);

        if (!override_balance_check && availableBalance < totalCost) {
          const error = new Error('Insufficient wallet balance and credit limit to purchase subscription');
          error.statusCode = 400;
          throw error;
        }

        // Create wallet transaction for base subscription plan
        const planTxnRef = this.generateTxnRef('TXN-SUB');
        const insertPlanTxnQuery = `
          INSERT INTO wallet_transactions (
            id, customer_id, amount, currency, before_balance, after_balance,
            transaction_type, reference, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          RETURNING *;
        `;

        await client.query(insertPlanTxnQuery, [
          uuidv4(),
          customer_id,
          -planAmount,
          plan.currency,
          beforeBalance,
          beforeBalance - planAmount,
          'subscription',
          planTxnRef,
          JSON.stringify({
            subscription_id: readableSubscriptionId,
            plan_id: plan.plan_id,
            plan_name: plan.name,
            amount: planAmount
          })
        ]);

        let runningBalance = beforeBalance - planAmount;

        // Create one wallet transaction per addon line (quantity tracked in metadata)
        for (const addonLine of addonCostBreakdown) {
          const addonTxnRef = this.generateTxnRef('TXN-ADDON');
          const nextRunningBalance = runningBalance - addonLine.lineTotal;

          await client.query(insertPlanTxnQuery, [
            uuidv4(),
            customer_id,
            -addonLine.lineTotal,
            addonLine.addon.currency,
            runningBalance,
            nextRunningBalance,
            'addon',
            addonTxnRef,
            JSON.stringify({
              subscription_id: readableSubscriptionId,
              addon_id: addonLine.addon.addon_id,
              addon_name: addonLine.addon.name,
              addon_type: addonLine.addon.addon_type,
              quantity: addonLine.quantity,
              recurring_total: addonLine.recurringTotal,
              setup_total: addonLine.setupTotal,
              total_amount: addonLine.lineTotal,
              free_seconds_granted: addonLine.addonFreeSeconds
            })
          ]);

          runningBalance = nextRunningBalance;
        }

        const fiatDebit = Math.min(beforeBalance, totalCost);
        const creditDebit = totalCost - fiatDebit;
        const afterFiatBalance = beforeBalance - fiatDebit;
        const afterCreditUsed = beforeCreditUsed + creditDebit;

        // Single multi-tier wallet update. Retail plans no longer grant free seconds.
        const updateWalletQuery = `
          UPDATE customer_wallets
          SET
            fiat_balance = $1,
            credit_used = $2,
            last_updated = now(),
            version = version + 1
          WHERE customer_id = $3 AND version = $4
          RETURNING *;
        `;

        const updatedWalletResult = await client.query(updateWalletQuery, [
          afterFiatBalance,
          afterCreditUsed,
          customer_id,
          wallet.version
        ]);

        if (!updatedWalletResult.rows[0]) {
          const error = new Error('Wallet update conflict. Please retry.');
          error.statusCode = 409;
          throw error;
        }

        // Insert subscription after successful debit checks and wallet transaction records
        const insertQuery = `
          INSERT INTO subscriptions (id, subscription_id, customer_id, plan_id, status, start_date, next_billing)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;

        const subValues = [subscriptionRowId, readableSubscriptionId, customer_id, plan_id, status, now, nextBilling];
        const result = await client.query(insertQuery, subValues);
        const subscription = result.rows[0];

        // Insert subscription addons (optional)
        const createdAddons = [];
        const insertSubAddonQuery = `
          INSERT INTO subscription_addons (
            id, subscription_id, addon_id, quantity, status,
            purchased_at, start_date, next_billing,
            total_setup_paid, total_recurring_paid, metadata
          ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10::jsonb)
          RETURNING *;
        `;

        for (const addonLine of addonCostBreakdown) {
          const addonRow = await client.query(insertSubAddonQuery, [
            uuidv4(),
            subscriptionRowId,
            addonLine.addon.addon_id,
            addonLine.quantity,
            now,
            now,
            nextBilling,
            addonLine.setupTotal,
            addonLine.recurringTotal,
            JSON.stringify({
              addon_type: addonLine.addon.addon_type,
              quantity: addonLine.quantity
            })
          ]);

          createdAddons.push(addonRow.rows[0]);
        }

        // Create free minutes grants and transactions for audit
        const insertGrantQuery = `
          INSERT INTO free_mins_grants (
            id, customer_id, source_type, source_id, granted_secs,
            valid_from, valid_to, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
          RETURNING *;
        `;

        const insertFreeTxnQuery = `
          INSERT INTO free_mins_transactions (
            id, customer_id, free_mins_grant_id, amount_secs, transaction_type, reference, metadata
          ) VALUES ($1, $2, $3, $4, 'grant', $5, $6::jsonb)
          RETURNING *;
        `;

        const createdFreeMinsGrants = [];

        const planFreeSeconds = Number(plan.free_mins || 0) * 60;
        if (planFreeSeconds > 0) {
          const planGrant = await client.query(insertGrantQuery, [
            uuidv4(),
            customer_id,
            'plan',
            plan.plan_id,
            planFreeSeconds,
            now,
            nextBilling
          ]);

          const planGrantRow = planGrant.rows[0];
          createdFreeMinsGrants.push(planGrantRow);

          await client.query(insertFreeTxnQuery, [
            uuidv4(),
            customer_id,
            planGrantRow.id,
            planFreeSeconds,
            `subscription_${readableSubscriptionId}_plan_grant`,
            JSON.stringify({
              source: 'plan',
              plan_id: plan.plan_id,
              free_secs: planFreeSeconds
            })
          ]);
        }

        for (const addonLine of addonCostBreakdown) {
          if (addonLine.addonFreeSeconds <= 0) {
            continue;
          }

          const addonGrant = await client.query(insertGrantQuery, [
            uuidv4(),
            customer_id,
            'addon',
            addonLine.addon.addon_id,
            addonLine.addonFreeSeconds,
            now,
            nextBilling
          ]);

          const addonGrantRow = addonGrant.rows[0];
          createdFreeMinsGrants.push(addonGrantRow);

          await client.query(insertFreeTxnQuery, [
            uuidv4(),
            customer_id,
            addonGrantRow.id,
            addonLine.addonFreeSeconds,
            `subscription_${readableSubscriptionId}_addon_${addonLine.addon.addon_id}_grant`,
            JSON.stringify({
              source: 'addon',
              addon_id: addonLine.addon.addon_id,
              quantity: addonLine.quantity,
              free_secs: addonLine.addonFreeSeconds
            })
          ]);
        }

        await client.query('COMMIT');

        await RecordingGateService.sync(customer_id, updatedWalletResult.rows[0]);

        // Emit event for asset creation service
        const subscriptionAddonIds = createdAddons.map(addon => addon.id);
        EventService.emit('subscription.created', {
          subscription_id: readableSubscriptionId,
          subscription_addon_ids: subscriptionAddonIds,
          subscription_row_id: subscriptionRowId
        });

        return {
          ...subscription,
          addons: createdAddons,
          wallet: {
            before_balance: beforeBalance,
            after_balance: afterFiatBalance,
            after_credit_used: afterCreditUsed,
            before_free_seconds: beforeFreeSeconds,
            after_free_seconds: Number(updatedWalletResult.rows[0].free_seconds),
            total_cost: totalCost,
            total_free_seconds_granted: totalFreeSeconds
          },
          free_mins_grants: createdFreeMinsGrants
        };
      } catch (txnErr) {
        await client.query('ROLLBACK');
        throw txnErr;
      } finally {
        client.release();
      }
    } catch (err) {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      throw err;
    }
  }

  static async findById(subscriptionId) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId);
    const whereClause = isUuid ? 'id = $1' : 'subscription_id = $1';

    const query = `SELECT * FROM subscriptions WHERE ${whereClause};`;
    try {
      const result = await pool.query(query, [subscriptionId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch subscription: ${err.message}`);
    }
  }

  static async findByCustomerId(customerId) {
    const query = 'SELECT * FROM subscriptions WHERE customer_id = $1 ORDER BY created_at DESC;';
    try {
      const result = await pool.query(query, [customerId]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch subscriptions: ${err.message}`);
    }
  }

  static async getAll() {
    const query = 'SELECT * FROM subscriptions ORDER BY created_at DESC;';
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch subscriptions: ${err.message}`);
    }
  }

  static async updateStatus(subscriptionId, status) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId);
    const whereClause = isUuid ? 'id = $1' : 'subscription_id = $1';

    const query = `
      UPDATE subscriptions
      SET status = $2, updated_at = now()
      WHERE ${whereClause}
      RETURNING *;
    `;

    try {
      const result = await pool.query(query, [subscriptionId, status]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to update subscription status: ${err.message}`);
    }
  }

  static async update(subscriptionId, updates) {
    const allowedFields = ['status', 'next_billing'];
    const updateFields = Object.keys(updates)
      .filter(key => allowedFields.includes(key))
      .map((key, index) => `${key} = $${index + 1}`)
      .join(', ');

    if (!updateFields) {
      throw new Error('No valid fields to update');
    }

    const values = Object.values(updates).filter((_, index) =>
      allowedFields.includes(Object.keys(updates)[index])
    );
    values.push(subscriptionId);

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId);
    const whereClause = isUuid ? `id = $${values.length}` : `subscription_id = $${values.length}`;

    const query = `
      UPDATE subscriptions
      SET ${updateFields}, updated_at = now()
      WHERE ${whereClause}
      RETURNING *;
    `;

    try {
      const result = await pool.query(query, values);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to update subscription: ${err.message}`);
    }
  }

  static async delete(subscriptionId) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId);
    const whereClause = isUuid ? 'id = $1' : 'subscription_id = $1';

    const query = `DELETE FROM subscriptions WHERE ${whereClause} RETURNING *;`;
    try {
      const result = await pool.query(query, [subscriptionId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to delete subscription: ${err.message}`);
    }
  }
}

module.exports = Subscription;
