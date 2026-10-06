const pool = require('../config/database');

class Addon {
  // Create Catalog Item
  static async createCatalogItem(data) {
    const {
      addon_id,
      name,
      resource_type = 'extension',
      units_count = 1,
      unit_price,
      currency = 'USD',
      is_active = true
    } = data;

    const query = `
      INSERT INTO subscription_addons_catalog (
        addon_id, name, resource_type, units_count, unit_price, currency, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (addon_id) DO UPDATE SET
        name = EXCLUDED.name,
        resource_type = EXCLUDED.resource_type,
        units_count = EXCLUDED.units_count,
        unit_price = EXCLUDED.unit_price,
        currency = EXCLUDED.currency,
        is_active = EXCLUDED.is_active
      RETURNING *;
    `;

    const values = [addon_id, name, resource_type, Math.max(1, parseInt(units_count, 10) || 1), unit_price, currency, is_active];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  // Get Catalog Item by ID
  static async getCatalogItemById(addonId) {
    const query = `SELECT * FROM subscription_addons_catalog WHERE addon_id = $1 AND is_active = true;`;
    const result = await pool.query(query, [addonId]);
    return result.rows[0] || null;
  }

  // Get all active catalog items
  static async getAllCatalogItems() {
    const query = `SELECT * FROM subscription_addons_catalog WHERE is_active = true ORDER BY created_at ASC;`;
    const result = await pool.query(query);
    return result.rows;
  }

  // Create active Customer Add-on Subscription
  static async createCustomerAddon(data) {
    const {
      subscription_id,
      customer_id,
      addon_id,
      quantity = 1,
      unit_price,
      prorated_charge_paid,
      resource_type = 'extension'
    } = data;

    const query = `
      INSERT INTO subscription_addons (
        subscription_id, addon_id, quantity, unit_price, prorated_charge_paid, resource_type, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
      RETURNING *;
    `;

    const values = [subscription_id, addon_id, quantity, unit_price, prorated_charge_paid, resource_type];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  // Get Active Add-ons for a Subscription
  static async getActiveAddonsBySubscriptionId(subscriptionId) {
    const query = `
      SELECT sa.*, sac.name, sac.unit_price as catalog_unit_price
      FROM subscription_addons sa
      LEFT JOIN subscription_addons_catalog sac ON sa.addon_id = sac.addon_id
      WHERE sa.subscription_id = $1 AND sa.status = 'active';
    `;
    const result = await pool.query(query, [subscriptionId]);
    return result.rows;
  }

  // Get a single subscription addon by its row ID
  static async getSubscriptionAddonById(subscriptionAddonId) {
    const query = `SELECT * FROM subscription_addons WHERE id = $1;`;
    const result = await pool.query(query, [subscriptionAddonId]);
    return result.rows[0] || null;
  }

  // Soft-delete a catalog item (set is_active = false)
  // Prevents deactivation if active subscription addons reference this catalog item
  static async deleteCatalogItem(addonId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Safety check: prevent deactivation if active subscription addons reference this catalog item
      const activeRes = await client.query(
        `SELECT COUNT(*)::int as count FROM subscription_addons WHERE addon_id = $1 AND status = 'active';`,
        [addonId]
      );
      if (activeRes.rows[0].count > 0) {
        const err = new Error(`Cannot delete add-on "${addonId}": ${activeRes.rows[0].count} active subscription addon(s) still reference it. Cancel those addons first.`);
        err.statusCode = 409;
        throw err;
      }

      const result = await client.query(
        `UPDATE subscription_addons_catalog SET is_active = false WHERE addon_id = $1 RETURNING *;`,
        [addonId]
      );

      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.statusCode) throw err;
      throw new Error(`Failed to delete catalog item: ${err.message}`);
    } finally {
      client.release();
    }
  }

  // Cancel an active subscription addon and recalculate subscription recurring totals
  static async cancelSubscriptionAddon(subscriptionAddonId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock and fetch the subscription addon
      const addonRes = await client.query(
        `SELECT * FROM subscription_addons WHERE id = $1 FOR UPDATE;`,
        [subscriptionAddonId]
      );
      const addon = addonRes.rows[0];
      if (!addon) {
        const err = new Error('Subscription add-on not found');
        err.statusCode = 404;
        throw err;
      }
      if (addon.status !== 'active') {
        const err = new Error(`Subscription add-on is already "${addon.status}"`);
        err.statusCode = 400;
        throw err;
      }

      // 2. Mark as cancelled
      await client.query(
        `UPDATE subscription_addons SET status = 'cancelled', cancelled_date = NOW(), updated_at = NOW() WHERE id = $1;`,
        [subscriptionAddonId]
      );

      // 3. Recalculate subscription recurring addon totals
      const recurringRes = await client.query(
        `SELECT COALESCE(SUM(quantity * unit_price), 0) as total_recurring FROM subscription_addons WHERE subscription_id = $1 AND status = 'active';`,
        [addon.subscription_id]
      );
      const recurringAddonsPrice = Number(recurringRes.rows[0].total_recurring);

      // 4. Update subscription totals
      const subRes = await client.query(
        `SELECT base_plan_price FROM subscriptions WHERE id = $1;`,
        [addon.subscription_id]
      );
      const basePlanPrice = Number(subRes.rows[0]?.base_plan_price || 0);
      const totalRecurringPrice = basePlanPrice + recurringAddonsPrice;

      await client.query(
        `UPDATE subscriptions SET recurring_addons_price = $1, total_recurring_price = $2, updated_at = NOW() WHERE id = $3;`,
        [recurringAddonsPrice, totalRecurringPrice, addon.subscription_id]
      );

      await client.query('COMMIT');

      return {
        cancelled_addon_id: subscriptionAddonId,
        addon_id: addon.addon_id,
        quantity: addon.quantity,
        new_recurring_addons_price: recurringAddonsPrice,
        new_total_recurring_price: totalRecurringPrice
      };
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.statusCode) throw err;
      throw new Error(`Failed to cancel subscription add-on: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

module.exports = Addon;
