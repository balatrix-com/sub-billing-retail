class WalletLockService {
  /**
   * Serializes all wallet mutations per customer for the current transaction.
   */
  static async acquireCustomerWalletLock(client, customerId) {
    if (!customerId) {
      throw new Error('customerId is required for wallet lock');
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [customerId]);
  }
}

module.exports = WalletLockService;
