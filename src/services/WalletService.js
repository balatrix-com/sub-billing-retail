const { pool, readonlyPool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const WalletLockService = require('./WalletLockService');

class WalletService {
  /**
   * Get wallet balance for a customer
   */
  static async getBalance(customerId) {
    const query = `
      SELECT customer_id, currency, fiat_balance, free_seconds, credit_limit, version, last_updated
      FROM customer_wallets
      WHERE customer_id = $1;
    `;

    try {
      const result = await readonlyPool.query(query, [customerId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch wallet: ${err.message}`);
    }
  }

  /**
   * Create wallet for a customer
   */
  static async createWallet(customerId) {
    const query = `
      INSERT INTO customer_wallets (customer_id, currency, fiat_balance, free_seconds, credit_limit)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    try {
      const result = await pool.query(query, [customerId, 'USD', 0, 0, 0]);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to create wallet: ${err.message}`);
    }
  }

  /**
   * Add fiat funds to wallet and record transaction
   */
  static async addFiatFunds(customerId, amount, currency, gateway, transactionId, metadata = {}) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await WalletLockService.acquireCustomerWalletLock(client, customerId);

      // Get current balance
      const balanceQuery = 'SELECT fiat_balance, version FROM customer_wallets WHERE customer_id = $1 FOR UPDATE;';
      const balanceResult = await client.query(balanceQuery, [customerId]);

      if (!balanceResult.rows[0]) {
        throw new Error('Wallet not found');
      }

      const beforeBalance = parseFloat(balanceResult.rows[0].fiat_balance);
      const afterBalance = beforeBalance + amount;
      const version = balanceResult.rows[0].version;

      // Update wallet balance
      const updateQuery = `
        UPDATE customer_wallets
        SET fiat_balance = $2, version = version + 1, last_updated = now()
        WHERE customer_id = $1 AND version = $3;
      `;
      const updateResult = await client.query(updateQuery, [customerId, afterBalance, version]);

      if (updateResult.rowCount === 0) {
        throw new Error('Wallet version mismatch - concurrent modification detected');
      }

      // Record transaction
      const txnQuery = `
        INSERT INTO wallet_transactions (
          id, customer_id, amount, currency, before_balance, after_balance,
          transaction_type, reference, gateway, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        RETURNING *;
      `;

      const txnResult = await client.query(txnQuery, [
        uuidv4(),
        customerId,
        amount,
        currency,
        beforeBalance,
        afterBalance,
        'payment',
        transactionId,
        gateway,
        JSON.stringify(metadata)
      ]);

      await client.query('COMMIT');
      return txnResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to add funds: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Debit fiat from wallet (for subscription charges)
   */
  static async debitFiat(customerId, amount, currency, reference, metadata = {}) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await WalletLockService.acquireCustomerWalletLock(client, customerId);

      // Get current balance
      const balanceQuery = 'SELECT fiat_balance, version FROM customer_wallets WHERE customer_id = $1 FOR UPDATE;';
      const balanceResult = await client.query(balanceQuery, [customerId]);

      if (!balanceResult.rows[0]) {
        throw new Error('Wallet not found');
      }

      const beforeBalance = parseFloat(balanceResult.rows[0].fiat_balance);
      const afterBalance = beforeBalance - amount;
      const version = balanceResult.rows[0].version;

      if (afterBalance < 0) {
        throw new Error('Insufficient fiat balance');
      }

      // Update wallet balance
      const updateQuery = `
        UPDATE customer_wallets
        SET fiat_balance = $2, version = version + 1, last_updated = now()
        WHERE customer_id = $1 AND version = $3;
      `;
      const updateResult = await client.query(updateQuery, [customerId, afterBalance, version]);

      if (updateResult.rowCount === 0) {
        throw new Error('Wallet version mismatch - concurrent modification detected');
      }

      // Record transaction
      const txnQuery = `
        INSERT INTO wallet_transactions (
          id, customer_id, amount, currency, before_balance, after_balance,
          transaction_type, reference, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *;
      `;

      const txnResult = await client.query(txnQuery, [
        uuidv4(),
        customerId,
        -amount,
        currency,
        beforeBalance,
        afterBalance,
        'subscription',
        reference,
        JSON.stringify(metadata)
      ]);

      await client.query('COMMIT');
      return txnResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to debit fiat: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Add free minutes to wallet
   */
  static async addFreeMins(customerId, secs, reference, metadata = {}) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await WalletLockService.acquireCustomerWalletLock(client, customerId);

      // Get current balance
      const balanceQuery = 'SELECT free_seconds, version FROM customer_wallets WHERE customer_id = $1 FOR UPDATE;';
      const balanceResult = await client.query(balanceQuery, [customerId]);

      if (!balanceResult.rows[0]) {
        throw new Error('Wallet not found');
      }

      const beforeBalance = balanceResult.rows[0].free_seconds;
      const afterBalance = beforeBalance + secs;
      const version = balanceResult.rows[0].version;

      // Update wallet balance
      const updateQuery = `
        UPDATE customer_wallets
        SET free_seconds = $2, version = version + 1, last_updated = now()
        WHERE customer_id = $1 AND version = $3;
      `;
      const updateResult = await client.query(updateQuery, [customerId, afterBalance, version]);

      if (updateResult.rowCount === 0) {
        throw new Error('Wallet version mismatch - concurrent modification detected');
      }

      // Record transaction
      const txnQuery = `
        INSERT INTO free_mins_transactions (
          id, customer_id, amount_secs, transaction_type, reference, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING *;
      `;

      const txnResult = await client.query(txnQuery, [
        uuidv4(),
        customerId,
        secs,
        'grant',
        reference,
        JSON.stringify(metadata)
      ]);

      await client.query('COMMIT');
      return txnResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to add free mins: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Debit free minutes from wallet
   */
  static async debitFreeMins(customerId, secs, reference, metadata = {}) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await WalletLockService.acquireCustomerWalletLock(client, customerId);

      // Get current balance
      const balanceQuery = 'SELECT free_seconds, version FROM customer_wallets WHERE customer_id = $1 FOR UPDATE;';
      const balanceResult = await client.query(balanceQuery, [customerId]);

      if (!balanceResult.rows[0]) {
        throw new Error('Wallet not found');
      }

      const beforeBalance = balanceResult.rows[0].free_seconds;
      const afterBalance = beforeBalance - secs;
      const version = balanceResult.rows[0].version;

      if (afterBalance < 0) {
        throw new Error('Insufficient free mins');
      }

      // Update wallet balance
      const updateQuery = `
        UPDATE customer_wallets
        SET free_seconds = $2, version = version + 1, last_updated = now()
        WHERE customer_id = $1 AND version = $3;
      `;
      const updateResult = await client.query(updateQuery, [customerId, afterBalance, version]);

      if (updateResult.rowCount === 0) {
        throw new Error('Wallet version mismatch - concurrent modification detected');
      }

      // Record transaction
      const txnQuery = `
        INSERT INTO free_mins_transactions (
          id, customer_id, amount_secs, transaction_type, reference, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING *;
      `;

      const txnResult = await client.query(txnQuery, [
        uuidv4(),
        customerId,
        -secs,
        'consume',
        reference,
        JSON.stringify(metadata)
      ]);

      await client.query('COMMIT');
      return txnResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to debit free mins: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get wallet transaction history
   */
  static async getTransactionHistory(customerId, limit = 50, offset = 0) {
    const query = `
      SELECT * FROM wallet_transactions
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3;
    `;

    try {
      const result = await readonlyPool.query(query, [customerId, limit, offset]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch transaction history: ${err.message}`);
    }
  }

  /**
   * Get free mins transaction history
   */
  static async getFreeMinsHistory(customerId, limit = 50, offset = 0) {
    const query = `
      SELECT * FROM free_mins_transactions
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3;
    `;

    try {
      const result = await pool.query(query, [customerId, limit, offset]);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch free mins history: ${err.message}`);
    }
  }
  /**
   * Get all active wallets (for Super Admin dashboard)
   */
  static async getAllWallets() {
    const query = `
      SELECT customer_id, currency, fiat_balance, free_seconds, last_updated
      FROM customer_wallets
      ORDER BY last_updated DESC;
    `;

    try {
      const result = await readonlyPool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch all wallets: ${err.message}`);
    }
  }

  /**
   * Update credit limit for a customer wallet
   */
  static async updateCreditLimit(customerId, creditLimit) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      await WalletLockService.acquireCustomerWalletLock(client, customerId);

      const balanceQuery = 'SELECT version FROM customer_wallets WHERE customer_id = $1 FOR UPDATE;';
      const balanceResult = await client.query(balanceQuery, [customerId]);

      if (!balanceResult.rows[0]) {
        throw new Error('Wallet not found');
      }

      const version = balanceResult.rows[0].version;

      const updateQuery = `
        UPDATE customer_wallets
        SET credit_limit = $2, version = version + 1, last_updated = now()
        WHERE customer_id = $1 AND version = $3
        RETURNING *;
      `;
      
      const updateResult = await client.query(updateQuery, [customerId, creditLimit, version]);
      
      if (updateResult.rowCount === 0) {
        throw new Error('Wallet version mismatch - concurrent modification detected');
      }

      await client.query('COMMIT');
      return updateResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to update credit limit: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

module.exports = WalletService;
