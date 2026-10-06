const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const StripeService = require('./StripeService');
const WalletLockService = require('./WalletLockService');

class PaymentService {
  /**
   * Generate human-readable payment ID
   */
  static generatePaymentId() {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `PAY-${year}${month}-${random}`;
  }

  /**
   * Initiate a new payment
   * @param {Object} params - Payment parameters
   * @returns {Object} Payment details with checkout URL
   */
  static async initiatePayment({ 
    customer_id, 
    amount, 
    currency = 'usd', 
    description,
    success_url,
    cancel_url,
    metadata = {},
    origin = 'Sub_billing'
  }) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify customer exists
      const customerCheck = await client.query(
        'SELECT customer_id FROM customers WHERE customer_id = $1',
        [customer_id]
      );

      if (customerCheck.rows.length === 0) {
        throw new Error(`Customer ${customer_id} not found`);
      }

      // Generate payment ID
      const payment_id = this.generatePaymentId();
      const paymentUUID = uuidv4();

      // Set default URLs if not provided
      const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
      const finalSuccessUrl = success_url || `${baseUrl}/api/payments/success?session_id={CHECKOUT_SESSION_ID}`;
      const finalCancelUrl = cancel_url || `${baseUrl}/api/payments/cancel?session_id={CHECKOUT_SESSION_ID}`;

      // Create Stripe checkout session
      const normalizedCurrency = (currency || 'usd').toLowerCase();
      const stripeSession = await StripeService.createCheckoutSession({
        customer_id,
        amount,
        currency: normalizedCurrency,
        description: description || `Wallet top-up for ${customer_id}`,
        success_url: finalSuccessUrl,
        cancel_url: finalCancelUrl,
        metadata: {
          Initiate_by: origin,
          payment_id,
          ...metadata
        }
      });

      // Store payment in database
      const insertQuery = `
        INSERT INTO payments (
          id, payment_id, transaction_id, customer_id, amount, currency, status,
          payment_method, gateway, stripe_session_id, stripe_payment_intent_id,
          success_url, cancel_url, description, metadata, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *;
      `;

      const paymentResult = await client.query(insertQuery, [
        paymentUUID,
        payment_id,
        payment_id,
        customer_id,
        amount,
        normalizedCurrency,
        'pending',
        'stripe',
        'stripe',
        stripeSession.session_id,
        stripeSession.payment_intent,
        finalSuccessUrl,
        finalCancelUrl,
        description,
        JSON.stringify({ Initiate_by: origin, ...metadata }),
        stripeSession.expires_at
      ]);

      // Record transaction
      await client.query(`
        INSERT INTO payment_transactions (
          id, payment_id, customer_id, transaction_type, amount, status, gateway_response
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        uuidv4(),
        paymentUUID,
        customer_id,
        'session_created',
        amount,
        'success',
        JSON.stringify(stripeSession)
      ]);

      await client.query('COMMIT');

      console.log(`[PaymentService] Payment initiated: ${payment_id}`);

      return {
        payment_id,
        checkout_url: stripeSession.checkout_url,
        stripe_session_id: stripeSession.session_id,
        amount,
        currency: normalizedCurrency,
        status: 'pending',
        expires_at: stripeSession.expires_at
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[PaymentService] Error initiating payment:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get payment status
   * @param {string} payment_id - Payment ID
   * @returns {Object} Payment details
   */
  static async getPaymentStatus(payment_id) {
    try {
      const query = `
        SELECT * FROM payments
        WHERE payment_id = $1 OR stripe_session_id = $1;
      `;

      const result = await pool.query(query, [payment_id]);

      if (result.rows.length === 0) {
        throw new Error('Payment not found');
      }

      return result.rows[0];
    } catch (error) {
      console.error('[PaymentService] Error getting payment status:', error.message);
      throw error;
    }
  }

  /**
   * Process successful payment webhook
   * @param {Object} webhookEvent - Stripe webhook event
   * @returns {Object} Processing result
   */
  static async processSuccessfulPayment(webhookEvent) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { type, data, id: webhook_id } = webhookEvent;
      const sessionData = data.object;

      // Log webhook received
      const webhookUUID = uuidv4();
      await client.query(`
        INSERT INTO payment_webhooks (
          id, webhook_id, event_type, payload, status
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        webhookUUID,
        webhook_id,
        type,
        JSON.stringify(webhookEvent),
        'received'
      ]);

      // Find payment by Stripe session ID
      const paymentQuery = `
        SELECT * FROM payments
        WHERE stripe_session_id = $1
        FOR UPDATE;
      `;

      const paymentResult = await client.query(paymentQuery, [sessionData.id]);

      if (paymentResult.rows.length === 0) {
        console.warn(`[PaymentService] Payment not found for session: ${sessionData.id}`);
        await client.query('COMMIT');
        return { status: 'ignored', reason: 'payment_not_found' };
      }

      const payment = paymentResult.rows[0];

      // Serialize wallet changes with other concurrent wallet mutators.
      await WalletLockService.acquireCustomerWalletLock(client, payment.customer_id);

      // Check if already processed (idempotency)
      if (payment.status === 'completed') {
        console.log(`[PaymentService] Payment ${payment.payment_id} already completed`);
        await client.query('COMMIT');
        return { status: 'ignored', reason: 'already_processed' };
      }

      // Update payment status
      await client.query(`
        UPDATE payments
        SET 
          status = $1,
          stripe_payment_intent_id = $2,
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id = $3
      `, [
        'completed',
        sessionData.payment_intent,
        payment.id
      ]);

      // Credit wallet
      await this.creditWallet(client, payment.customer_id, payment.amount, payment.payment_id);

      // Record transaction
      await client.query(`
        INSERT INTO payment_transactions (
          id, payment_id, customer_id, transaction_type, amount, status, gateway_response
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        uuidv4(),
        payment.id,
        payment.customer_id,
        'webhook_received',
        payment.amount,
        'success',
        JSON.stringify(sessionData)
      ]);

      // Update webhook status
      await client.query(`
        UPDATE payment_webhooks
        SET status = $1, processed_at = NOW(), payment_id = $2
        WHERE id = $3
      `, ['processed', payment.id, webhookUUID]);

      await client.query('COMMIT');

      console.log(`[PaymentService] ✓ Payment ${payment.payment_id} completed and wallet credited`);

      return {
        status: 'processed',
        payment_id: payment.payment_id,
        amount: payment.amount
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[PaymentService] Error processing payment webhook:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Credit customer wallet
   * @param {Object} client - Database client
   * @param {string} customer_id - Customer ID
   * @param {number} amount - Amount to credit
   * @param {string} payment_id - Payment ID for reference
   */
  static async creditWallet(client, customer_id, amount, payment_id) {
    await WalletLockService.acquireCustomerWalletLock(client, customer_id);

    // Lock wallet for update
    const walletQuery = `
      SELECT fiat_balance, version
      FROM customer_wallets
      WHERE customer_id = $1
      FOR UPDATE;
    `;

    const walletResult = await client.query(walletQuery, [customer_id]);

    if (walletResult.rows.length === 0) {
      throw new Error(`Wallet not found for customer ${customer_id}`);
    }

    const wallet = walletResult.rows[0];
    const before_balance = wallet.fiat_balance;
    const after_balance = parseFloat(before_balance) + parseFloat(amount);

    // Update wallet balance
    const updateQuery = `
      UPDATE customer_wallets
      SET 
        fiat_balance = fiat_balance + $1,
        version = version + 1,
        last_updated = NOW()
      WHERE customer_id = $2 AND version = $3
      RETURNING *;
    `;

    const updateResult = await client.query(updateQuery, [
      amount,
      customer_id,
      wallet.version
    ]);

    if (updateResult.rows.length === 0) {
      throw new Error('Wallet version mismatch - concurrent modification detected');
    }

    // Create wallet transaction record
    await client.query(`
      INSERT INTO wallet_transactions (
        id, customer_id, amount, currency, before_balance, after_balance,
        transaction_type, reference, processed_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
    `, [
      uuidv4(),
      customer_id,
      amount,
      'usd',
      before_balance,
      after_balance,
      'payment',
      payment_id,
      JSON.stringify({ payment_id, source: 'stripe' })
    ]);

    // Record payment transaction
    await client.query(`
      INSERT INTO payment_transactions (
        id, payment_id, customer_id, transaction_type, amount, status
      ) VALUES ($1, (SELECT id FROM payments WHERE payment_id = $2), $3, $4, $5, $6)
    `, [
      uuidv4(),
      payment_id,
      customer_id,
      'wallet_credited',
      amount,
      'success'
    ]);

    console.log(`[PaymentService] Wallet credited: ${customer_id} +$${amount} (${before_balance} → ${after_balance})`);
  }

  /**
   * Get payment history for a customer
   * @param {string} customer_id - Customer ID
   * @param {number} limit - Number of records to return
   * @returns {Array} Payment history
   */
  static async getPaymentHistory(customer_id, limit = 20) {
    try {
      const query = `
        SELECT 
          payment_id, amount, currency, status, payment_method,
          description, created_at, completed_at
        FROM payments
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT $2;
      `;

      const result = await pool.query(query, [customer_id, limit]);
      return result.rows;
    } catch (error) {
      console.error('[PaymentService] Error getting payment history:', error.message);
      throw error;
    }
  }

  /**
   * Cancel a pending payment
   * @param {string} payment_id - Payment ID
   * @returns {Object} Cancellation result
   */
  static async cancelPayment(payment_id) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const payment = await client.query(
        'SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE',
        [payment_id]
      );

      if (payment.rows.length === 0) {
        throw new Error('Payment not found');
      }

      const paymentData = payment.rows[0];

      if (paymentData.status !== 'pending') {
        throw new Error(`Cannot cancel payment with status: ${paymentData.status}`);
      }

      await client.query(`
        UPDATE payments
        SET status = $1, updated_at = NOW()
        WHERE payment_id = $2
      `, ['cancelled', payment_id]);

      await client.query('COMMIT');

      console.log(`[PaymentService] Payment cancelled: ${payment_id}`);

      return { success: true, message: 'Payment cancelled' };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[PaymentService] Error cancelling payment:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Record a manual payment and credit customer wallet
   * @param {Object} params - Payment parameters
   * @returns {Object} Result of the operation
   */
  static async recordManualPayment({
    customer_id,
    amount,
    currency = 'usd',
    tx_id,
    payment_type = 'manual',
    description
  }) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify customer exists
      const customerCheck = await client.query(
        'SELECT customer_id FROM customers WHERE customer_id = $1',
        [customer_id]
      );

      if (customerCheck.rows.length === 0) {
        throw new Error(`Customer ${customer_id} not found`);
      }

      // Generate internal payment ID
      const payment_id = this.generatePaymentId();
      const paymentUUID = uuidv4();

      // Store payment in database (status: completed)
      const insertQuery = `
        INSERT INTO payments (
          id, payment_id, transaction_id, customer_id, amount, currency, status,
          payment_method, gateway, description, metadata, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        RETURNING *;
      `;

      await client.query(insertQuery, [
        paymentUUID,
        payment_id,
        tx_id, // External transaction ID from manager
        customer_id,
        amount,
        currency.toLowerCase(),
        'completed',
        payment_type,
        'manual',
        description || `Manual payment: ${tx_id}`,
        JSON.stringify({ external_tx_id: tx_id, manual: true })
      ]);

      // Credit wallet (reusing existing robust logic)
      await this.creditWallet(client, customer_id, amount, payment_id);

      // Record transaction history
      await client.query(`
        INSERT INTO payment_transactions (
          id, payment_id, customer_id, transaction_type, amount, status
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        uuidv4(),
        paymentUUID,
        customer_id,
        'manual_credit',
        amount,
        'success'
      ]);

      await client.query('COMMIT');

      console.log(`[PaymentService] Manual payment recorded: ${payment_id} for ${customer_id}`);

      return {
        success: true,
        payment_id,
        customer_id,
        amount,
        status: 'completed'
      };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[PaymentService] Error recording manual payment:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }
  /**
   * Get all payment details
   */
  static async getAllPaymentDetails() {
    try {
      const query = `
        SELECT payment_id, customer_id, amount, description
        FROM payments
        ORDER BY created_at DESC;
      `;
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      console.error('[PaymentService] Error getting all payment details:', error.message);
      throw error;
    }
  }

  /**
   * Get payment details by customer ID
   */
  static async getPaymentDetailsByCustomerId(customer_id) {
    try {
      const query = `
        SELECT payment_id, customer_id, amount, description
        FROM payments
        WHERE customer_id = $1
        ORDER BY created_at DESC;
      `;
      const result = await pool.query(query, [customer_id]);
      return result.rows;
    } catch (error) {
      console.error('[PaymentService] Error getting payment details by customer ID:', error.message);
      throw error;
    }
  }
}

module.exports = PaymentService;
