const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const EventService = require('./EventService');

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
               p.tfns, p.dids, p.extensions, p.monitoring_per_user
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
        dids: await this.getNextDidIndex(client),
        extensions: await this.getNextExtensionIndex(client, customer_id),
        tfns: await this.getNextTfnIndex(client),
        monitoring: await this.getNextMonitoringIndex(client)
      };

      const createdAssets = [];

      // 1. CREATE ASSETS FROM PLAN
      const planAssets = {
        dids: Number(subscription.dids || 0),
        extensions: Number(subscription.extensions || 0),
        tfns: Number(subscription.tfns || 0),
        monitoring: Number(subscription.monitoring_per_user || 0)
      };

      // Create DIDs from plan (blank placeholder until manually assigned by Super Admin)
      for (let i = 0; i < planAssets.dids; i++) {
        await client.query(`
          INSERT INTO did_assets (
            id, customer_id, subscription_id, source_type, source_id,
            subscription_addon_id, did_number, did_name, status, assigned_date, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          uuidv4(), customer_id, subscriptionUUID, 'plan', plan_id,
          null, null, `DID from ${plan_id}`, 'unassigned', new Date(), JSON.stringify({ plan_id })
        ]);

        createdAssets.push({ type: 'DID', value: null, status: 'unassigned', source: 'plan' });
      }

      // Create Extensions from plan
      for (let i = 0; i < planAssets.extensions; i++) {
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

      // Create TFNs from plan (blank placeholder until manually assigned by Super Admin)
      for (let i = 0; i < planAssets.tfns; i++) {
        await client.query(`
          INSERT INTO tfn_assets (
            id, customer_id, subscription_id, source_type, source_id,
            subscription_addon_id, tfn_number, tfn_name, status, assigned_date, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          uuidv4(), customer_id, subscriptionUUID, 'plan', plan_id,
          null, null, `TFN from ${plan_id}`, 'unassigned', new Date(), JSON.stringify({ plan_id })
        ]);

        createdAssets.push({ type: 'TFN', value: null, status: 'unassigned', source: 'plan' });
      }

      // Create Monitoring from plan
      for (let i = 0; i < planAssets.monitoring; i++) {
        const userId = await this.generateMonitoring(assetIndex.monitoring++);

        await client.query(`
          INSERT INTO monitoring_assets (
            id, customer_id, subscription_id, source_type, source_id,
            subscription_addon_id, user_id, user_name, user_email, status, assigned_date, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          uuidv4(), customer_id, subscriptionUUID, 'plan', plan_id,
          null, userId, userId, `${userId}@company.local`, 'active', new Date(), JSON.stringify({ plan_id })
        ]);

        createdAssets.push({ type: 'MONITORING', value: userId, source: 'plan' });
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
          } else if (assetType === 'TFN' || assetType.includes('TOLL')) {
            for (let i = 0; i < assetCount; i++) {
              await client.query(`
                INSERT INTO tfn_assets (
                  id, customer_id, subscription_id, source_type, source_id,
                  subscription_addon_id, tfn_number, tfn_name, status, assigned_date, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              `, [
                uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
                subscriptionAddonId, null, `TFN from ${addon_id}`, 'unassigned', new Date(), JSON.stringify({ addon_id, quantity })
              ]);

              createdAssets.push({ type: 'TFN', value: null, status: 'unassigned', source: 'addon', addon_id });
            }
          } else if (assetType === 'DID') {
            for (let i = 0; i < assetCount; i++) {
              await client.query(`
                INSERT INTO did_assets (
                  id, customer_id, subscription_id, source_type, source_id,
                  subscription_addon_id, did_number, did_name, status, assigned_date, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              `, [
                uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
                subscriptionAddonId, null, `DID from ${addon_id}`, 'unassigned', new Date(), JSON.stringify({ addon_id, quantity })
              ]);

              createdAssets.push({ type: 'DID', value: null, status: 'unassigned', source: 'addon', addon_id });
            }
          } else if (assetType === 'MONITORING' || assetType === 'MON') {
            for (let i = 0; i < assetCount; i++) {
              const userId = await this.generateMonitoring(assetIndex.monitoring++);

              await client.query(`
                INSERT INTO monitoring_assets (
                  id, customer_id, subscription_id, source_type, source_id,
                  subscription_addon_id, user_id, user_name, user_email, status, assigned_date, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
              `, [
                uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
                subscriptionAddonId, userId, userId, `${userId}@company.local`, 'active', new Date(), JSON.stringify({ addon_id, quantity })
              ]);

              createdAssets.push({ type: 'MONITORING', value: userId, source: 'addon', addon_id });
            }
          }
        }
      }

      await client.query('COMMIT');

      // Notify PBX backend to provision & sync extensions to PBX DB & Kamailio
      try {
        const rawUrl = process.env.PBX_API_URL || 'http://localhost:3000/api';
        const pbxUrl = rawUrl.endsWith('/api') ? rawUrl : `${rawUrl}/api`;
        fetch(`${pbxUrl}/telecom/extensions/sync-from-billing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: customer_id })
        }).catch(err => {
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
        dids: await this.getNextDidIndex(client),
        extensions: await this.getNextExtensionIndex(client, customer_id),
        tfns: await this.getNextTfnIndex(client),
        monitoring: await this.getNextMonitoringIndex(client)
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
      } else if (assetType === 'TFN' || assetType.includes('TOLL')) {
        for (let i = 0; i < assetCount; i++) {
          await client.query(`
            INSERT INTO tfn_assets (
              id, customer_id, subscription_id, source_type, source_id,
              subscription_addon_id, tfn_number, tfn_name, status, assigned_date, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
            id, null, `TFN from ${addon_id}`, 'unassigned', new Date(), JSON.stringify({ addon_id, quantity })
          ]);
          createdAssets.push({ type: 'TFN', value: null, status: 'unassigned', source: 'addon', addon_id });
        }
      } else if (assetType === 'DID') {
        for (let i = 0; i < assetCount; i++) {
          await client.query(`
            INSERT INTO did_assets (
              id, customer_id, subscription_id, source_type, source_id,
              subscription_addon_id, did_number, did_name, status, assigned_date, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
            id, null, `DID from ${addon_id}`, 'unassigned', new Date(), JSON.stringify({ addon_id, quantity })
          ]);
          createdAssets.push({ type: 'DID', value: null, status: 'unassigned', source: 'addon', addon_id });
        }
      } else if (assetType === 'MONITORING' || assetType === 'MON') {
        for (let i = 0; i < assetCount; i++) {
          const userId = await this.generateMonitoring(assetIndex.monitoring++);
          await client.query(`
            INSERT INTO monitoring_assets (
              id, customer_id, subscription_id, source_type, source_id,
              subscription_addon_id, user_id, user_name, user_email, status, assigned_date, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [
            uuidv4(), customer_id, subscriptionUUID, 'addon', addon_id,
            id, userId, userId, `${userId}@company.local`, 'active', new Date(), JSON.stringify({ addon_id, quantity })
          ]);
          createdAssets.push({ type: 'MONITORING', value: userId, source: 'addon', addon_id });
        }
      }

      await client.query('COMMIT');

      // Notify PBX backend to provision & sync extensions to PBX DB & Kamailio
      try {
        const rawUrl = process.env.PBX_API_URL || 'http://localhost:3000/api';
        const pbxUrl = rawUrl.endsWith('/api') ? rawUrl : `${rawUrl}/api`;
        fetch(`${pbxUrl}/telecom/extensions/sync-from-billing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: customer_id })
        }).catch(err => {
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
    const rawTfns = Array.isArray(assets.tfns) ? assets.tfns : [];
    const rawDids = Array.isArray(assets.dids) ? assets.dids : [];
    
    // Deduplicate input to prevent processing the same number twice in one call
    const tfns = [...new Set(rawTfns.map(n => String(n).trim()).filter(Boolean))];
    const dids = [...new Set(rawDids.map(n => String(n).trim()).filter(Boolean))];

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Fetch the subscription row UUID by subscription_id, customer_id (e.g. U1007), or row UUID
      const subRes = await client.query(`
        SELECT id, subscription_id, customer_id 
        FROM subscriptions 
        WHERE subscription_id = $1 OR customer_id = $1 OR id::text = $1
        ORDER BY created_at DESC 
        LIMIT 1;
      `, [subscriptionId]);

      if (subRes.rows.length === 0) {
        throw new Error(`Subscription not found for identifier: ${subscriptionId}`);
      }
      const subscriptionUUID = subRes.rows[0].id;
      const customerId = subRes.rows[0].customer_id;
      const readableSubId = subRes.rows[0].subscription_id;

      // Sync TFNs
      for (const tfn of tfns) {
        // 1. Check if this TFN already exists in the system
        const existingRes = await client.query(`SELECT subscription_id, id FROM tfn_assets WHERE tfn_number = $1`, [tfn]);
        
        if (existingRes.rows.length > 0) {
          const ownerSubUUID = existingRes.rows[0].subscription_id;
          if (ownerSubUUID === subscriptionUUID) {
            console.log(`[AssetService] TFN ${tfn} already assigned to subscription ${readableSubId}, ensuring active.`);
            await client.query(`UPDATE tfn_assets SET status = 'active', updated_at = now() WHERE id = $1`, [existingRes.rows[0].id]);
            continue;
          } else {
            console.warn(`[AssetService] TFN ${tfn} is already assigned to a DIFFERENT subscription (${ownerSubUUID}). Reassigning to ${readableSubId}.`);
            await client.query(`UPDATE tfn_assets SET subscription_id = $1, customer_id = $2, status = 'active', updated_at = now() WHERE id = $3`, [subscriptionUUID, customerId, existingRes.rows[0].id]);
            continue;
          }
        }

        // 2. Find an unassigned placeholder TFN for this subscription
        const placeholderRes = await client.query(`
          SELECT id FROM tfn_assets 
          WHERE subscription_id = $1 AND (tfn_number IS NULL OR tfn_number LIKE 'TFN_%' OR status = 'unassigned')
          ORDER BY (tfn_number IS NULL) DESC, created_at ASC 
          LIMIT 1
        `, [subscriptionUUID]);

        if (placeholderRes.rows.length > 0) {
          await client.query(`
            UPDATE tfn_assets 
            SET tfn_number = $1, status = 'active', updated_at = now() 
            WHERE id = $2
          `, [tfn, placeholderRes.rows[0].id]);
          console.log(`[AssetService] Synced TFN ${tfn} for subscription ${readableSubId}`);
        } else {
          // If no placeholder, insert as new active TFN asset
          await client.query(`
            INSERT INTO tfn_assets (
              id, customer_id, subscription_id, source_type, source_id,
              subscription_addon_id, tfn_number, tfn_name, status, assigned_date, metadata
            ) VALUES ($1, $2, $3, 'plan', 'manual_assignment', null, $4, $5, 'active', now(), '{}'::jsonb)
          `, [uuidv4(), customerId, subscriptionUUID, tfn, `TFN ${tfn}`]);
          console.log(`[AssetService] Created new TFN asset ${tfn} for subscription ${readableSubId}`);
        }
      }

      // Sync DIDs
      for (const did of dids) {
        // 1. Check if this DID already exists
        const existingRes = await client.query(`SELECT subscription_id, id FROM did_assets WHERE did_number = $1`, [did]);
        
        if (existingRes.rows.length > 0) {
          const ownerSubUUID = existingRes.rows[0].subscription_id;
          if (ownerSubUUID === subscriptionUUID) {
            console.log(`[AssetService] DID ${did} already assigned to subscription ${readableSubId}, ensuring active.`);
            await client.query(`UPDATE did_assets SET status = 'active', updated_at = now() WHERE id = $1`, [existingRes.rows[0].id]);
            continue;
          } else {
            console.warn(`[AssetService] DID ${did} is already assigned to a DIFFERENT subscription (${ownerSubUUID}). Reassigning to ${readableSubId}.`);
            await client.query(`UPDATE did_assets SET subscription_id = $1, customer_id = $2, status = 'active', updated_at = now() WHERE id = $3`, [subscriptionUUID, customerId, existingRes.rows[0].id]);
            continue;
          }
        }

        // 2. Find an unassigned placeholder DID for this subscription
        const placeholderRes = await client.query(`
          SELECT id FROM did_assets 
          WHERE subscription_id = $1 AND (did_number IS NULL OR did_number ~ '^\\+1-800-555-[0-9]{4}$' OR did_number LIKE 'DID_%' OR status = 'unassigned')
          ORDER BY (did_number IS NULL) DESC, created_at ASC 
          LIMIT 1
        `, [subscriptionUUID]);

        if (placeholderRes.rows.length > 0) {
          await client.query(`
            UPDATE did_assets 
            SET did_number = $1, status = 'active', updated_at = now() 
            WHERE id = $2
          `, [did, placeholderRes.rows[0].id]);
          console.log(`[AssetService] Synced DID ${did} for subscription ${readableSubId}`);
        } else {
          // If no placeholder, insert as new active DID asset
          await client.query(`
            INSERT INTO did_assets (
              id, customer_id, subscription_id, source_type, source_id,
              subscription_addon_id, did_number, did_name, status, assigned_date, metadata
            ) VALUES ($1, $2, $3, 'plan', 'manual_assignment', null, $4, $5, 'active', now(), '{}'::jsonb)
          `, [uuidv4(), customerId, subscriptionUUID, did, `DID ${did}`]);
          console.log(`[AssetService] Created new DID asset ${did} for subscription ${readableSubId}`);
        }
      }

      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[AssetService] Error syncing assets:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  static async unassignAssets(assets) {
    const rawTfns = Array.isArray(assets.tfns) ? assets.tfns : [];
    const rawDids = Array.isArray(assets.dids) ? assets.dids : [];

    const tfns = [...new Set(rawTfns.map(n => String(n).trim()).filter(Boolean))];
    const dids = [...new Set(rawDids.map(n => String(n).trim()).filter(Boolean))];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (tfns.length > 0) {
        await client.query(`
          UPDATE tfn_assets 
          SET tfn_number = NULL, status = 'unassigned', updated_at = now() 
          WHERE tfn_number = ANY($1::text[]);
        `, [tfns]);
        console.log(`[AssetService] Unassigned TFNs: ${tfns.join(', ')}`);
      }

      if (dids.length > 0) {
        await client.query(`
          UPDATE did_assets 
          SET did_number = NULL, status = 'unassigned', updated_at = now() 
          WHERE did_number = ANY($1::text[]);
        `, [dids]);
        console.log(`[AssetService] Unassigned DIDs: ${dids.join(', ')}`);
      }

      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[AssetService] Error unassigning assets:`, err);
      throw err;
    } finally {
      client.release();
    }
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
