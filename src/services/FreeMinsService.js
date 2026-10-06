const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const WalletLockService = require('./WalletLockService');

class FreeMinsService {
  /**
   * Create a free mins grant
   */
  static async grantFreeMins(customerId, sourceType, sourceId, grantedSecs, validFrom, validTo) {
    const query = `
      INSERT INTO free_mins_grants (
        id, customer_id, source_type, source_id, granted_secs, valid_from, valid_to, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    try {
      const result = await pool.query(query, [
        uuidv4(),
        customerId,
        sourceType,
        sourceId,
        grantedSecs,
        validFrom,
        validTo,
        'active'
      ]);

      // Add to wallet
      await this._updateWalletFreeMins(customerId, grantedSecs, 'grant', sourceId);

      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to grant free mins: ${err.message}`);
    }
  }

  /**
   * Get active free mins grants for a customer
   */
  static async getActiveGrants(customerId) {
    const query = `
      SELECT * FROM free_mins_grants
      WHERE customer_id = $1 
        AND status = 'active'
        AND valid_to > now()
      ORDER BY valid_from DESC;
    `;

    try {
      const result = await pool.query(query, [customerId]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch active grants: ${err.message}`);
    }
  }

  /**
   * Get all free mins grants for a customer
   */
  static async getAllGrants(customerId) {
    const query = `
      SELECT * FROM free_mins_grants
      WHERE customer_id = $1
      ORDER BY created_at DESC;
    `;

    try {
      const result = await pool.query(query, [customerId]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch grants: ${err.message}`);
    }
  }

  /**
   * Mark expired grants and remove from wallet
   */
  static async expireGrants(customerId, existingClient = null) {
    const shouldManageTransaction = !existingClient;
    const client = existingClient || await pool.connect();

    try {
      if (shouldManageTransaction) await client.query('BEGIN');

      // Find expired grants
      const expiredQuery = `
        SELECT id, granted_secs FROM free_mins_grants
        WHERE customer_id = $1 
          AND status = 'active'
          AND valid_to <= now()
        FOR UPDATE;
      `;

      const expiredResult = await client.query(expiredQuery, [customerId]);

      let totalExpired = 0;

      for (const grant of expiredResult.rows) {
        // Mark as expired
        const markExpiredQuery = `
          UPDATE free_mins_grants
          SET status = 'expired'
          WHERE id = $1;
        `;

        await client.query(markExpiredQuery, [grant.id]);

        // Record expiry transaction
        const txnQuery = `
          INSERT INTO free_mins_transactions (
            id, customer_id, free_mins_grant_id, amount_secs, transaction_type, reference
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *;
        `;

        await client.query(txnQuery, [
          uuidv4(),
          customerId,
          grant.id,
          -grant.granted_secs,
          'expiry_purge',
          `grant_${grant.id}_expired`
        ]);

        totalExpired += grant.granted_secs;
      }

      // Update wallet if there were expired grants
      if (totalExpired > 0) {
        await WalletLockService.acquireCustomerWalletLock(client, customerId);

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

        const beforeFreeSeconds = Number(walletRows.rows[0].free_seconds || 0);
        const nextFreeSeconds = Math.max(0, beforeFreeSeconds - Number(totalExpired || 0));
        const version = walletRows.rows[0].version;

        const walletQuery = `
          UPDATE customer_wallets
          SET free_seconds = $2, version = version + 1, last_updated = now()
          WHERE customer_id = $1 AND version = $3;
        `;

        const walletUpdate = await client.query(walletQuery, [customerId, nextFreeSeconds, version]);
        if (walletUpdate.rowCount === 0) {
          throw new Error('Wallet version mismatch - concurrent modification detected');
        }
      }

      if (shouldManageTransaction) await client.query('COMMIT');
      return { expired_grants: expiredResult.rows.length, total_secs: totalExpired };
    } catch (err) {
      if (shouldManageTransaction) await client.query('ROLLBACK');
      throw new Error(`Failed to expire grants: ${err.message}`);
    } finally {
      if (shouldManageTransaction) client.release();
    }
  }

  /**
   * Process all expired grants across all customers
   */
  static async processAllExpiries() {
    try {
      const query = `
        SELECT DISTINCT customer_id 
        FROM free_mins_grants 
        WHERE status = 'active' AND valid_to <= now();
      `;
      const result = await pool.query(query);
      
      const stats = {
        customers_processed: 0,
        total_grants_expired: 0,
        total_secs_expired: 0
      };

      for (const row of result.rows) {
        const res = await this.expireGrants(row.customer_id);
        stats.customers_processed++;
        stats.total_grants_expired += res.expired_grants;
        stats.total_secs_expired += res.total_secs;
      }

      return stats;
    } catch (err) {
      throw new Error(`Failed to process all expiries: ${err.message}`);
    }
  }

  /**
   * Get free mins grant by ID
   */
  static async getGrant(grantId) {
    const query = 'SELECT * FROM free_mins_grants WHERE id = $1;';

    try {
      const result = await pool.query(query, [grantId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch grant: ${err.message}`);
    }
  }

  /**
   * Get free mins by source (plan or addon)
   */
  static async getGrantsBySource(customerId, sourceType, sourceId) {
    const query = `
      SELECT * FROM free_mins_grants
      WHERE customer_id = $1 
        AND source_type = $2
        AND source_id = $3
      ORDER BY created_at DESC;
    `;

    try {
      const result = await pool.query(query, [customerId, sourceType, sourceId]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch grants: ${err.message}`);
    }
  }

  /**
   * Helper: Update wallet free mins balance
   */
  static async _updateWalletFreeMins(customerId, amount, type, reference) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await WalletLockService.acquireCustomerWalletLock(client, customerId);

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

      const beforeFreeSeconds = Number(walletRows.rows[0].free_seconds || 0);
      const nextFreeSeconds = beforeFreeSeconds + Number(amount || 0);
      const version = walletRows.rows[0].version;

      const query = `
        UPDATE customer_wallets
        SET free_seconds = $2, version = version + 1, last_updated = now()
        WHERE customer_id = $1 AND version = $3;
      `;

      const walletUpdate = await client.query(query, [customerId, nextFreeSeconds, version]);
      if (walletUpdate.rowCount === 0) {
        throw new Error('Wallet version mismatch - concurrent modification detected');
      }

      // Record transaction
      const txnQuery = `
        INSERT INTO free_mins_transactions (
          id, customer_id, amount_secs, transaction_type, reference
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `;

      const result = await client.query(txnQuery, [
        uuidv4(),
        customerId,
        amount,
        type,
        reference
      ]);

      await client.query('COMMIT');

      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to update wallet: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get free mins statistics for a customer
   */
  static async getFreeMinsStats(customerId) {
    const query = `
      SELECT
        SUM(granted_secs) as total_granted,
        COUNT(*) as total_grants,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_grants,
        COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired_grants
      FROM free_mins_grants
      WHERE customer_id = $1;
    `;

    try {
      const result = await pool.query(query, [customerId]);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to fetch free mins stats: ${err.message}`);
    }
  }
}

module.exports = FreeMinsService;
