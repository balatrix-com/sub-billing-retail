const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const EventService = require('./EventService');
const { createRetailNumberAssets } = require('./RetailNumberAssets');
const { signedHeaders } = require('../middleware/serviceAuth');
const retailNumberAssets = createRetailNumberAssets(pool);

function notifyPbxExtensionSync(customerId) {
  const rawUrl = process.env.PBX_API_URL || 'http://localhost:3000/api';
  const pbxUrl = rawUrl.endsWith('/api') ? rawUrl : `${rawUrl}/api`;
  const url = `${pbxUrl}/telecom/extensions/sync-from-billing`;
  const body = JSON.stringify({ customerId });
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', url, body) },
    body,
  });
}

class AssetService {
  static async generateDID(index) {
    // Generate proper 10-digit US phone numbers: +1-800-555-XXXX
    // index 0 → +18005550001, index 1 → +18005550002, etc.
    const seq = String(index + 1).padStart(4, '0');
    return `+1-800-555-${seq}`;
  }

  static async generateExtension(customerId, index) {
    // Format: {customerId}{sequence} (e.g. U101901, U101902)
    // Matches PBX backend standard exactly.
    const sequence = String(index + 1).padStart(2, '0');
    return `${customerId}${sequence}`;
  }

  static async generateTFN(index) {
    // Generate TFN codes like TFN_001, TFN_002, etc.
    return `TFN_${String(index + 1).padStart(3, '0')}`;
  }

  static async generateMonitoring(index) {
    // Generate monitoring user IDs like MON_001, MON_002, etc.
    return `MON_${String(index + 1).padStart(3, '0')}`;
  }

  static async getNextTfnIndex(client) {
    const result = await client.query(`
      SELECT tfn_number FROM tfn_assets
      WHERE tfn_number ~ '^TFN_[0-9]+$'
      ORDER BY CAST(SUBSTRING(tfn_number FROM 5) AS INTEGER) DESC
      LIMIT 1;
    `);
    if (result.rows.length === 0) return 0;
    // Extract numeric part (e.g., TFN_002 -> 2)
    return parseInt(result.rows[0].tfn_number.substring(4), 10);
  }

  static async getNextDidIndex(client) {
    const result = await client.query(`
      SELECT did_number FROM did_assets
      WHERE did_number ~ '^\\+1-800-555-[0-9]{4}$'
      ORDER BY CAST(SUBSTRING(did_number FROM 13) AS INTEGER) DESC
      LIMIT 1;
    `);
    if (result.rows.length === 0) return 0;
    // Extract 4-digit sequence (e.g., +1-800-555-0001 -> 1)
    return parseInt(result.rows[0].did_number.split('-').pop(), 10);
  }

  static async getNextMonitoringIndex(client) {
    const result = await client.query(`
      SELECT user_id FROM monitoring_assets
      WHERE user_id ~ '^MON_[0-9]+$'
      ORDER BY CAST(SUBSTRING(user_id FROM 5) AS INTEGER) DESC
      LIMIT 1;
    `);
    if (result.rows.length === 0) return 0;
    // Extract numeric part (e.g., MON_002 -> 2)
    return parseInt(result.rows[0].user_id.substring(4), 10);
  }

  static async getNextExtensionIndex(client, customerId) {
    const result = await client.query(`
      SELECT extension_number FROM extension_assets
      WHERE customer_id = $1
      ORDER BY CAST(SUBSTRING(extension_number FROM length($1) + 1) AS INTEGER) DESC
      LIMIT 1;
    `, [customerId]);
    if (result.rows.length === 0) return 0;
    return parseInt(result.rows[0].extension_number.substring(customerId.length), 10);
  }

  static async createAssetsForSubscription(subscriptionId, subscriptionAddonIds, subscriptionRowId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Fetch subscription with plan details
      const subQuery = `
        SELECT s.id, s.subscription_id, s.customer_id, s.plan_id, 
               p.extensions, p.numbers, p.monitoring_extensions
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.plan_id
        WHERE s.subscription_id = $1;
      `;
      const subResult = await client.query(subQuery, [subscriptionId]);

      if (!subResult.rows[0]) {
        throw new Error(`Subscription not found: ${subscriptionId}`);
      }

      const subscription = subResult.rows[0];
      const { customer_id, plan_id } = subscription;
      const subscriptionUUID = subscription.id; // Use actual UUID from DB

      let assetIndex = {
        extensions: await this.getNextExtensionIndex(client, customer_id)
      };

      const createdAssets = [];

      // 1. CREATE ASSETS FROM PLAN
      // Number and monitoring limits are entitlements, not placeholder assets.
      // PBX Admins assign real numbers and monitoring seats within these limits.
      const planExtensions = Number(subscription.extensions || 0);

      // Create Extensions from plan
      for (let i = 0; i < planExtensions; i++) {
        const extensionNumber = await this.generateExtension(customer_id, assetIndex.extensions++);

        await client.query(`
          INSERT INTO extension_assets (
            id, customer_id, subscription_id, source_type, source_id,
            subscription_addon_id, extension_number, extension_name, extension_type, status, assigned_date, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          uuidv4(), customer_id, subscriptionUUID, 'plan', plan_id,
          null, extensionNumber, `Extension from ${plan_id}`, 'user', 'active', new Date(), JSON.stringify({ plan_id })
        ]);

        createdAssets.push({ type: 'EXTENSION', value: extensionNumber, source: 'plan' });
      }

      // 2. CREATE ASSETS FROM ADDONS
      if (Array.isArray(subscriptionAddonIds) && subscriptionAddonIds.length > 0) {
        const addonsQuery = `
          SELECT sa.id, sa.addon_id, sa.quantity, sa.resource_type as sub_resource_type, 
                 a.addon_type, sac.resource_type as catalog_resource_type, sac.units_count
          FROM subscription_addons sa
          LEFT JOIN addons a ON sa.addon_id = a.addon_id
          LEFT JOIN subscription_addons_catalog sac ON sa.addon_id = sac.addon_id
          WHERE sa.id = ANY($1::uuid[]);
        `;

        const addonsResult = await client.query(addonsQuery, [subscriptionAddonIds]);

        for (const addon of addonsResult.rows) {
          const { id: subscriptionAddonId, addon_id, quantity, sub_resource_type, addon_type, catalog_resource_type, units_count } = addon;
          let rawType = catalog_resource_type || sub_resource_type || addon_type || '';
          if (!rawType && addon_id) {
            const up = addon_id.toUpperCase();
            if (up.includes('TFN') || up.includes('TOLL')) rawType = 'TFN';
            else if (up.includes('DID')) rawType = 'DID';
            else if (up.includes('EXT')) rawType = 'EXTENSION';
            else if (up.includes('MON')) rawType = 'MONITORING';
          }
          const assetType = rawType.toUpperCase();
          const bundleUnits = Number(units_count || 1);
          const assetCount = Number(quantity || 1) * bundleUnits;

          if (assetType === 'EXT' || assetType === 'EXTENSION') {
            for (let i = 0; i < assetCount; i++) {
              const extensionNumber = await this.generateExtension(customer_id, assetIndex.extensions++);

              await client.query(`
                INSERT INTO extension_assets (
                  id, customer_id, subscription_id, source_type, source_id,
                  subscription_addon_id, extension_number, extension_name, extension_type, status, assigned_date, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
              `, [
                uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
                subscriptionAddonId, extensionNumber, `Extension from ${addon_id}`, 'user', 'active', new Date(), JSON.stringify({ addon_id, quantity })
              ]);

              createdAssets.push({ type: 'EXTENSION', value: extensionNumber, source: 'addon', addon_id });
            }
          } else if (['MONITORING_EXTENSION', 'MONITORING', 'MON'].includes(assetType)) {
            // A monitoring add-on grants a seat; the PBX Admin assigns it to a real user.
          } else if (['TFN', 'DID'].includes(assetType) || assetType.includes('TOLL')) {
            throw new Error(`${assetType} number add-ons are not supported; numbers are controlled by the plan`);
          }
        }
      }

      await client.query('COMMIT');

      // Notify PBX backend to provision & sync extensions to PBX DB & Kamailio
      try {
        notifyPbxExtensionSync(customer_id).catch(err => {
          console.warn(`[AssetService] PBX extension sync notification warning: ${err.message}`);
        });
      } catch (e) {}

      console.log(`[AssetService] Created ${createdAssets.length} assets for subscription ${subscriptionId}`);
      return createdAssets;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[AssetService] Error creating assets:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  static async createAssetsForAddon(subscriptionAddonId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const addonsQuery = `
        SELECT sa.id, sa.subscription_id, sa.addon_id, sa.quantity, sa.resource_type as sub_resource_type, 
               a.addon_type, sac.resource_type as catalog_resource_type, sac.units_count,
               s.customer_id, s.subscription_id as readable_sub_id
        FROM subscription_addons sa
        JOIN subscriptions s ON sa.subscription_id = s.id
        LEFT JOIN addons a ON sa.addon_id = a.addon_id
        LEFT JOIN subscription_addons_catalog sac ON sa.addon_id = sac.addon_id
        WHERE sa.id = $1;
      `;
      const res = await client.query(addonsQuery, [subscriptionAddonId]);
      if (res.rows.length === 0) {
        await client.query('ROLLBACK');
        return [];
      }
      const addon = res.rows[0];
      const { id, subscription_id: subscriptionUUID, customer_id, addon_id, quantity, sub_resource_type, addon_type, catalog_resource_type, units_count } = addon;
      let rawType = catalog_resource_type || sub_resource_type || addon_type || '';
      if (!rawType && addon_id) {
        const up = addon_id.toUpperCase();
        if (up.includes('TFN') || up.includes('TOLL')) rawType = 'TFN';
        else if (up.includes('DID')) rawType = 'DID';
        else if (up.includes('EXT')) rawType = 'EXTENSION';
        else if (up.includes('MON')) rawType = 'MONITORING';
      }
      const assetType = rawType.toUpperCase();
      const bundleUnits = Number(units_count || 1);
      const assetCount = Number(quantity || 1) * bundleUnits;
      const createdAssets = [];

      let assetIndex = {
        extensions: await this.getNextExtensionIndex(client, customer_id)
      };

      if (assetType === 'EXT' || assetType === 'EXTENSION') {
        for (let i = 0; i < assetCount; i++) {
          const extensionNumber = await this.generateExtension(customer_id, assetIndex.extensions++);
          await client.query(`
            INSERT INTO extension_assets (
              id, customer_id, subscription_id, source_type, source_id,
              subscription_addon_id, extension_number, extension_name, extension_type, status, assigned_date, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [
            uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
            id, extensionNumber, `Extension from ${addon_id}`, 'user', 'active', new Date(), JSON.stringify({ addon_id, quantity })
          ]);
          createdAssets.push({ type: 'EXTENSION', value: extensionNumber, source: 'addon', addon_id });
        }
      } else if (['MONITORING_EXTENSION', 'MONITORING', 'MON'].includes(assetType)) {
        // Purchased seat is counted by the PBX; no placeholder asset is needed.
      } else if (['TFN', 'DID'].includes(assetType) || assetType.includes('TOLL')) {
        throw new Error(`${assetType} number add-ons are not supported; numbers are controlled by the plan`);
      }

      await client.query('COMMIT');

      // Notify PBX backend to provision & sync extensions to PBX DB & Kamailio
      try {
        notifyPbxExtensionSync(customer_id).catch(err => {
          console.warn(`[AssetService] PBX addon extension sync notification warning: ${err.message}`);
        });
      } catch (e) {}

      console.log(`[AssetService] Created ${createdAssets.length} addon assets for subscription ${addon.readable_sub_id}`);
      return createdAssets;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[AssetService] Error creating assets for addon:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  static async suspendAssetsForSubscription(subscriptionRowId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tfn_assets SET status = 'suspended', updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId]);
      await client.query(`UPDATE did_assets SET status = 'suspended', updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId]);
      await client.query(`UPDATE extension_assets SET status = 'suspended', updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId]);
      await client.query(`UPDATE monitoring_assets SET status = 'suspended', updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId]);
      await client.query('COMMIT');
      console.log(`[AssetService] Suspended assets for subscription ${subscriptionRowId}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[AssetService] Error suspending assets:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  static async reactivateAssetsForSubscription(subscriptionRowId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tfn_assets SET status = 'active', updated_at = now() WHERE subscription_id = $1 AND tfn_number IS NOT NULL`, [subscriptionRowId]);
      await client.query(`UPDATE did_assets SET status = 'active', updated_at = now() WHERE subscription_id = $1 AND did_number IS NOT NULL`, [subscriptionRowId]);
      await client.query(`UPDATE extension_assets SET status = 'active', updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId]);
      await client.query(`UPDATE monitoring_assets SET status = 'active', updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId]);
      await client.query('COMMIT');
      console.log(`[AssetService] Reactivated assets for subscription ${subscriptionRowId}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[AssetService] Error reactivating assets:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  static async cancelAssetsForSubscription(subscriptionRowId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      await client.query(`UPDATE tfn_assets SET status = 'cancelled', cancelled_date = $2, updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId, now]);
      await client.query(`UPDATE did_assets SET status = 'cancelled', cancelled_date = $2, updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId, now]);
      await client.query(`UPDATE extension_assets SET status = 'cancelled', cancelled_date = $2, updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId, now]);
      await client.query(`UPDATE monitoring_assets SET status = 'cancelled', cancelled_date = $2, updated_at = now() WHERE subscription_id = $1`, [subscriptionRowId, now]);
      await client.query('COMMIT');
      console.log(`[AssetService] Cancelled assets for subscription ${subscriptionRowId}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[AssetService] Error cancelling assets:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  static async syncAssets(subscriptionId, assets) {
    return retailNumberAssets.syncAssets(subscriptionId, assets);
  }

  static async unassignAssets(subscriptionId, assets) {
    return retailNumberAssets.unassignAssets(subscriptionId, assets);
  }
  static async initialize() {
    // Listen for subscription creation events
    EventService.on('subscription.created', async (data) => {
      try {
        const { subscription_id, subscription_addon_ids, subscription_row_id } = data;
        console.log(`[AssetService] Processing subscription ${subscription_id}...`);

        await this.createAssetsForSubscription(subscription_id, subscription_addon_ids, subscription_row_id);

        console.log(`[AssetService] Successfully created assets for ${subscription_id}`);
      } catch (err) {
        console.error(`[AssetService] Failed to create assets:`, err);
      }
    });

    // Listen for subscription cancellation events
    EventService.on('subscription.cancelled', async (data) => {
      try {
        const { subscription_id, subscription_row_id } = data;
        console.log(`[AssetService] Processing cancellation for ${subscription_id}...`);

        await this.teardownAssetsForSubscription(subscription_row_id);
      } catch (err) {
        console.error(`[AssetService] Failed to teardown assets:`, err);
      }
    });
  }
}

module.exports = AssetService;
