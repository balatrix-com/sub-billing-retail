const AddonModel = require('../models/Addon');
const CustomerModel = require('../models/Customer');
const pool = require('../config/database');
const ProrationService = require('../services/ProrationService');
const AssetService = require('../services/AssetService');
const RecordingGateService = require('../services/RecordingGateService');

class AddonController {
  // Create or Update Catalog Addon Item
  static async createAddonCatalogItem(req, res) {
    try {
      const { addon_id, name, resource_type, units_count = 1, unit_price, currency, is_active } = req.body;
      if (!addon_id || !name || unit_price === undefined) {
        return res.status(400).json({ success: false, message: 'addon_id, name, and unit_price are required' });
      }

      const item = await AddonModel.createCatalogItem({
        addon_id,
        name,
        resource_type,
        units_count: Math.max(1, parseInt(units_count, 10) || 1),
        unit_price,
        currency,
        is_active
      });

      res.status(201).json({ success: true, message: 'Add-on catalog item saved successfully', data: item });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Get Active Addon Catalog
  static async getAddonCatalog(req, res) {
    try {
      const catalog = await AddonModel.getAllCatalogItems();
      res.status(200).json({ success: true, data: catalog });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Calculate Mid-Cycle Addon Proration Quote
  static async getAddonQuote(req, res) {
    try {
      const { customer_id, addon_id, quantity = 1 } = req.body;
      if (!customer_id || !addon_id) {
        return res.status(400).json({ success: false, message: 'customer_id and addon_id are required' });
      }

      // 1. Get Customer Active Subscription
      const subQuery = `SELECT * FROM subscriptions WHERE customer_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1;`;
      const subRes = await pool.query(subQuery, [customer_id]);
      const subscription = subRes.rows[0];
      if (!subscription) {
        return res.status(404).json({ success: false, message: 'Active subscription not found for customer' });
      }

      // 2. Get Catalog Addon Item
      const addon = await AddonModel.getCatalogItemById(addon_id);
      if (!addon) {
        return res.status(404).json({ success: false, message: 'Add-on item not found in catalog' });
      }

      // 3. Get Customer Wallet Purchasing Power
      const wallet = await CustomerModel.getWallet(customer_id);
      const availablePower = wallet ? wallet.available_purchasing_power : 0;

      // 4. Calculate Proration Quote
      const quote = ProrationService.calculateProrationQuote({
        unitPrice: addon.unit_price,
        quantity,
        startDate: new Date(),
        endDate: subscription.next_billing || subscription.end_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });

      const sufficientFunds = availablePower >= quote.prorated_charge_due;

      res.status(200).json({
        success: true,
        customer_id,
        subscription_id: subscription.subscription_id,
        addon_id: addon.addon_id,
        name: addon.name,
        resource_type: addon.resource_type,
        quantity: quote.quantity,
        unit_price: quote.unit_price,
        remaining_days: quote.remaining_days,
        total_cycle_days: quote.total_cycle_days,
        prorated_charge_due: quote.prorated_charge_due,
        available_purchasing_power: availablePower,
        sufficient_funds: sufficientFunds
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Purchase Mid-Cycle Addon
  static async purchaseAddon(req, res) {
    const client = await pool.connect();
    try {
      const { customer_id, addon_id, quantity = 1 } = req.body;
      if (!customer_id || !addon_id) {
        return res.status(400).json({ success: false, message: 'customer_id and addon_id are required' });
      }

      await client.query('BEGIN');

      // 1. Get Subscription
      const subRes = await client.query(
        `SELECT * FROM subscriptions WHERE customer_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1 FOR UPDATE;`,
        [customer_id]
      );
      const subscription = subRes.rows[0];
      if (!subscription) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Active subscription not found for customer' });
      }

      // 2. Get Catalog Addon
      const addonRes = await client.query(
        `SELECT * FROM subscription_addons_catalog WHERE addon_id = $1 AND is_active = true;`,
        [addon_id]
      );
      const addon = addonRes.rows[0];
      if (!addon) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Add-on item not found' });
      }

      // 3. Get Wallet
      const walletRes = await client.query(
        `SELECT * FROM customer_wallets WHERE customer_id = $1 FOR UPDATE;`,
        [customer_id]
      );
      const wallet = walletRes.rows[0];
      if (!wallet) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Wallet not found' });
      }

      const fiatBalance = Number(wallet.fiat_balance || 0);
      const creditLimit = Number(wallet.credit_limit || 0);
      const creditUsed = Number(wallet.credit_used || 0);
      const availablePower = fiatBalance + Math.max(0, creditLimit - creditUsed);

      // 4. Proration Quote
      const quote = ProrationService.calculateProrationQuote({
        unitPrice: addon.unit_price,
        quantity,
        startDate: new Date(),
        endDate: subscription.next_billing || subscription.end_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });

      const chargeAmount = quote.prorated_charge_due;
      if (availablePower < chargeAmount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Insufficient purchasing power ($${availablePower.toFixed(2)}) for prorated charge ($${chargeAmount.toFixed(2)})`
        });
      }

      // 5. Debit Multi-Tier Wallet (Fiat balance first, then credit)
      let newFiat = fiatBalance;
      let newCreditUsed = creditUsed;

      if (newFiat >= chargeAmount) {
        newFiat -= chargeAmount;
      } else {
        const remainingCharge = chargeAmount - newFiat;
        newFiat = 0;
        newCreditUsed += remainingCharge;
      }

      await client.query(
        `UPDATE customer_wallets SET fiat_balance = $1, credit_used = $2, last_updated = NOW() WHERE customer_id = $3;`,
        [newFiat, newCreditUsed, customer_id]
      );

      // 6. Create Customer Subscription Addon Record
      const addonInsert = await client.query(
        `INSERT INTO subscription_addons (
          subscription_id, addon_id, quantity, unit_price, prorated_charge_paid, resource_type, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *;`,
        [subscription.id, addon.addon_id, quantity, addon.unit_price, chargeAmount, addon.resource_type]
      );

      // 7. Recalculate Subscription Recurring Addon Totals
      const recurringAddonTotalRes = await client.query(
        `SELECT SUM(quantity * unit_price) as total_recurring FROM subscription_addons WHERE subscription_id = $1 AND status = 'active';`,
        [subscription.id]
      );
      const recurringAddonsPrice = Number(recurringAddonTotalRes.rows[0].total_recurring || 0);
      const basePlanPrice = Number(subscription.base_plan_price || subscription.amount || 0);
      const totalRecurringPrice = basePlanPrice + recurringAddonsPrice;

      await client.query(
        `UPDATE subscriptions SET recurring_addons_price = $1, total_recurring_price = $2, updated_at = NOW() WHERE id = $3;`,
        [recurringAddonsPrice, totalRecurringPrice, subscription.id]
      );

      await client.query('COMMIT');

      await RecordingGateService.sync(customer_id, {
        fiat_balance: newFiat,
        credit_limit: creditLimit,
        credit_used: newCreditUsed
      });

      // Asynchronously/safely provision addon assets with source_type = 'addon'
      try {
        await AssetService.createAssetsForAddon(addonInsert.rows[0].id);
      } catch (assetErr) {
        console.error('[AddonController] Error creating assets for purchased addon:', assetErr);
      }

      res.status(200).json({
        success: true,
        message: 'Add-on purchased successfully',
        data: {
          customer_id,
          subscription_id: subscription.subscription_id,
          addon_purchased: addonInsert.rows[0],
          prorated_charge_paid: chargeAmount,
          net_fiat_balance: newFiat,
          net_credit_used: newCreditUsed,
          new_total_recurring_price: totalRecurringPrice
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, message: error.message });
    } finally {
      client.release();
    }
  }

  // Delete (soft-deactivate) a catalog add-on item
  static async deleteAddonCatalogItem(req, res) {
    try {
      const { addonId } = req.params;

      const item = await AddonModel.deleteCatalogItem(addonId);

      if (!item) {
        return res.status(404).json({
          success: false,
          message: 'Add-on catalog item not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Add-on catalog item deactivated successfully',
        data: item
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get all active add-ons for a subscription
  static async getSubscriptionAddons(req, res) {
    try {
      const { subscriptionId } = req.params;
      const addons = await AddonModel.getActiveAddonsBySubscriptionId(subscriptionId);

      res.status(200).json({
        success: true,
        data: addons
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Cancel an active subscription add-on
  static async cancelSubscriptionAddon(req, res) {
    try {
      const { subscriptionAddonId } = req.params;
      const result = await AddonModel.cancelSubscriptionAddon(subscriptionAddonId);

      res.status(200).json({
        success: true,
        message: 'Subscription add-on cancelled successfully',
        data: result
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        message: error.message
      });
    }
  }
}

module.exports = AddonController;
