const pool = require('../config/database');
const cron = require('node-cron');
const { createSubscriptionLifecycle } = require('./SubscriptionLifecycle');
const lifecycle = createSubscriptionLifecycle(pool);

class BillingService {
  static initialize() {
    if (this._initialized) return;
    this._initialized = true;
    cron.schedule('*/5 * * * *', async () => {
      try {
        const result = await this.processAllRenewals();
        console.log('[BillingService] Subscription lifecycle run:', result.processed, 'processed,', result.failed, 'failed');
      } catch (e) { console.error('[BillingService]', e.message); }
    });
  }
  static async processAllRenewals() {
    return lifecycle.tick(process.env.SUBSCRIPTION_WORKER_DRY_RUN !== 'false');
  }
  static async processSubscriptionRenewal(id, operationKey) {
    if (!operationKey) throw Object.assign(new Error('Renewal operation key is required'), { statusCode: 400 });
    return lifecycle.renew(id, operationKey, 'manual');
  }
}
module.exports = BillingService;
