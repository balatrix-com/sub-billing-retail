const WalletService = require('./WalletService');
const StripeService = require('./StripeService');
const CdrService = require('./CdrService');
const { pool, readonlyPool } = require('../config/database');

class PBXDashboardService {
  /**
   * Get formatted balance for PBX Dashboard
   * @param {string} customerId 
   */
  static async getCustomerBalance(customerId) {
    const wallet = await WalletService.getBalance(customerId);
    
    if (!wallet) {
      throw new Error(`Wallet not found for customer ${customerId}`);
    }

    // Format the balances per PBX dashboard requirements
    const fBalanceStr = `${wallet.currency.toUpperCase()} ${parseFloat(wallet.fiat_balance).toFixed(2)}`;
    
    // Convert free_seconds to free minutes
    const minsBalanceStr = Math.floor(wallet.free_seconds / 60);

    return {
      customer_id: wallet.customer_id,
      f_balance: fBalanceStr,
      "mins Balance": minsBalanceStr, // The requirement originally stated "mins Blance", corrected here for clarity.
      credit_limit: parseFloat(wallet.credit_limit || 0),
      f_credit_limit: `${wallet.currency.toUpperCase()} ${parseFloat(wallet.credit_limit || 0).toFixed(2)}`
    };
  }

  /**
   * Get formatted transactions for PBX Dashboard
   * @param {string} customerId 
   */
  static async getTransactions(customerId) {
    const txns = await WalletService.getTransactionHistory(customerId);
    
    return txns.map(t => ({
      id: t.id,
      amount: parseFloat(t.amount),
      type: t.transaction_type,
      description: t.reference || t.transaction_type,
      date: t.created_at
    }));
  }

  /**
   * Get all wallet balances for Super Admin dashboard
   */
  static async getAllBalances() {
    const wallets = await WalletService.getAllWallets();
    
    return wallets.map(w => ({
      customer_id: w.customer_id,
      balance: parseFloat(w.fiat_balance),
      currency: w.currency.toUpperCase(),
      freeMins: Math.floor(w.free_seconds / 60),
      lastUpdated: w.last_updated
    }));
  }

  /**
   * Get active subscription details for PBX Dashboard
   * @param {string} customerId 
   */
  static async getSubscriptionDetails(customerId) {
    const query = `
      SELECT 
        s.subscription_id, s.status, s.next_billing,
        p.name as plan_name, p.amount, p.currency,
        p.extensions, p.free_mins, p.validity_months
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.plan_id
      WHERE s.customer_id = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1;
    `;

    try {
      const result = await readonlyPool.query(query, [customerId]);
      const sub = result.rows[0];
      
      if (!sub) return null;

      return {
        subscription_id: sub.subscription_id,
        status: sub.status,
        plan_name: sub.plan_name,
        amount: parseFloat(sub.amount),
        currency: sub.currency.toUpperCase(),
        next_billing: sub.next_billing,
        limits: {
          extensions: sub.extensions,
          free_mins: sub.free_mins
        }
      };
    } catch (err) {
      console.error(`[PBXDashboardService] Error fetching subscription:`, err);
      return null;
    }
  }

  /**
   * List payment methods for PBX Dashboard
   * @param {string} customerId 
   */
  static async getPaymentMethods(customerId) {
    return await StripeService.listPaymentMethods(customerId);
  }
  /**
   * Get CDRs formatted for PBX Dashboard
   * @param {string} customerId 
   * @param {Object} filters
   */
  static async getCustomerCDRs(customerId, filters = {}) {
    return await CdrService.getCdrsByCustomerId(customerId, filters);
  }

  /**
   * Get all CDRs formatted for PBX Dashboard
   * @param {Object} filters
   */
  static async getAllCDRs(filters = {}) {
    return await CdrService.getAllCdrs(filters);
  }
}

module.exports = PBXDashboardService;
