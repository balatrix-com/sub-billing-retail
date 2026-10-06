const PBXDashboardService = require('../services/PBXDashboardService');
const AssetService = require('../services/AssetService');
const { pool } = require('../config/database');

class PBXDashboardController {
  static async getCustomerBalance(req, res) {
    try {
      const { customerId } = req.params;
      
      const pbxData = await PBXDashboardService.getCustomerBalance(customerId);
      
      res.status(200).json(pbxData);
    } catch (err) {
      console.error(`[PBXDashboardController] Error:`, err);
      if (err.message.includes('Wallet not found')) {
        return res.status(404).json({ error: err.message });
      }
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getTransactions(req, res) {
    try {
      const { customerId } = req.params;
      const transactions = await PBXDashboardService.getTransactions(customerId);
      res.status(200).json(transactions);
    } catch (err) {
      console.error(`[PBXDashboardController] Error fetching transactions:`, err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getAllBalances(req, res) {
    try {
      const balances = await PBXDashboardService.getAllBalances();
      res.status(200).json(balances);
    } catch (err) {
      console.error(`[PBXDashboardController] Error fetching all balances:`, err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getSubscriptionDetails(req, res) {
    try {
      const { customerId } = req.params;
      const subscription = await PBXDashboardService.getSubscriptionDetails(customerId);
      res.status(200).json(subscription);
    } catch (err) {
      console.error(`[PBXDashboardController] Error fetching subscription:`, err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getPaymentMethods(req, res) {
    try {
      const { customerId } = req.params;
      const methods = await PBXDashboardService.getPaymentMethods(customerId);
      res.status(200).json(methods);
    } catch (err) {
      console.error(`[PBXDashboardController] Error fetching payment methods:`, err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
  static async getCustomerCDRs(req, res) {
    try {
      const { customerId } = req.params;
      const { startDate, endDate, limit, offset } = req.query;
      
      const result = await PBXDashboardService.getCustomerCDRs(customerId, { 
        startDate, 
        endDate, 
        limit: limit === 'all' ? 'all' : (limit ? parseInt(limit) : 50),
        offset: offset ? parseInt(offset) : 0
      });
      
      res.status(200).json(result);
    } catch (err) {
      console.error(`[PBXDashboardController] Error fetching CDRs:`, err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  }

  static async getAllCDRs(req, res) {
    try {
      const { search, startDate, endDate, limit, offset } = req.query;
      
      const result = await PBXDashboardService.getAllCDRs({ 
        search,
        startDate, 
        endDate, 
        limit: limit === 'all' ? 'all' : (limit ? parseInt(limit) : 50),
        offset: offset ? parseInt(offset) : 0
      });
      
      res.status(200).json(result);
    } catch (err) {
      console.error(`[PBXDashboardController] Error fetching all CDRs:`, err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  }

  static async syncAssets(req, res) {
    try {
      const { subscriptionId } = req.params;
      const { tfns, dids } = req.body;
      
      const result = await AssetService.syncAssets(subscriptionId, { tfns, dids });
      res.status(200).json(result);
    } catch (err) {
      console.error(`[PBXDashboardController] Error syncing assets:`, err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  }

  static async unassignAssets(req, res) {
    try {
      const { tfns, dids } = req.body;
      const result = await AssetService.unassignAssets({ tfns, dids });
      res.status(200).json(result);
    } catch (err) {
      console.error(`[PBXDashboardController] Error unassigning assets:`, err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  }

  static async getSubscriptionAssets(req, res) {
    try {
      const { subscriptionId } = req.params;
      const client = await pool.connect();
      try {
        const subRes = await client.query('SELECT id FROM subscriptions WHERE subscription_id = $1', [subscriptionId]);
        if (subRes.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
        const subUUID = subRes.rows[0].id;

        const tfns = await client.query('SELECT tfn_number FROM tfn_assets WHERE subscription_id = $1', [subUUID]);
        const dids = await client.query('SELECT did_number FROM did_assets WHERE subscription_id = $1', [subUUID]);

        res.json({
          subscriptionId,
          tfns: tfns.rows.map(r => r.tfn_number),
          dids: dids.rows.map(r => r.did_number),
          totalTfns: tfns.rows.length,
          totalDids: dids.rows.length,
          placeholders: {
            tfns: tfns.rows.filter(r => r.tfn_number.startsWith('TFN_')).length,
            dids: dids.rows.filter(r => r.did_number.startsWith('+1-800-555-')).length
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`[PBXDashboardController] Error fetching subscription assets:`, error);
      res.status(500).json({ error: error.message });
    }
  }
  static async getCustomerAssets(req, res) {
    try {
      const { customerId } = req.params;
      // Find subscription for customer (prioritizing active subscription)
      const subRes = await pool.query(
        `SELECT id, subscription_id FROM subscriptions 
         WHERE customer_id = $1 
         ORDER BY CASE WHEN status = 'active' THEN 1 ELSE 2 END, created_at DESC 
         LIMIT 1`,
        [customerId]
      );
      if (subRes.rows.length === 0) {
        return res.status(404).json({ error: 'No active subscription found for customer' });
      }
      const { id: subscriptionUUID, subscription_id } = subRes.rows[0];

      const [tfnRes, didRes, extRes] = await Promise.all([
        pool.query('SELECT id, source_id, source_type, tfn_number, tfn_name, status, assigned_date, created_at FROM tfn_assets WHERE subscription_id = $1 ORDER BY created_at ASC', [subscriptionUUID]),
        pool.query('SELECT id, source_id, source_type, did_number, did_name, status, assigned_date, created_at FROM did_assets WHERE subscription_id = $1 ORDER BY created_at ASC', [subscriptionUUID]),
        pool.query('SELECT id, source_id, source_type, extension_number, extension_name, extension_type, status, assigned_date, created_at FROM extension_assets WHERE subscription_id = $1 ORDER BY created_at ASC', [subscriptionUUID])
      ]);

      res.json({
        customerId,
        subscriptionId: subscription_id,
        tfns: tfnRes.rows,
        dids: didRes.rows,
        extensions: extRes.rows,
        totals: {
          tfns: tfnRes.rows.length,
          dids: didRes.rows.length,
          extensions: extRes.rows.length
        }
      });
    } catch (err) {
      console.error(`[PBXDashboardController] Error fetching customer assets:`, err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  }
}

module.exports = PBXDashboardController;
