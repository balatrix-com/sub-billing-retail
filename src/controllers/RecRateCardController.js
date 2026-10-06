const RecRateCard = require('../models/RecRateCard');
const CacheRefreshService = require('../services/CacheRefreshService');

const ALLOWED_RETENTION_PERIODS = [7, 15, 30];

class RecRateCardController {
  static async updateRateCard(req, res) {
    try {
      const { retention_period } = req.body;
      if (retention_period !== undefined && !ALLOWED_RETENTION_PERIODS.includes(Number(retention_period))) {
        return res.status(400).json({
          success: false,
          message: `Invalid retention_period. Allowed values are ${ALLOWED_RETENTION_PERIODS.join(', ')} days.`
        });
      }
      const rateCard = await RecRateCard.update(req.params.id, req.body);
      if (!rateCard) {
        return res.status(404).json({ success: false, message: 'Rate card not found' });
      }
      CacheRefreshService.triggerRecordRefresh();
      res.json({ success: true, data: rateCard });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  static async getCustomerRateCard(req, res) {
    try {
      const rateCard = await RecRateCard.getCustomerRateCard(req.params.custId);
      if (!rateCard) {
        return res.status(404).json({ success: false, message: 'Customer rate card mapping not found' });
      }
      res.json({ success: true, data: rateCard });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async updateCustomerRateCard(req, res) {
    try {
      const { rec_rc_id } = req.body;
      if (!rec_rc_id) {
        return res.status(400).json({ success: false, message: 'rec_rc_id is required' });
      }
      const mapping = await RecRateCard.updateCustomerRateCard(req.params.custId, rec_rc_id);
      CacheRefreshService.triggerRecordRefresh();
      res.json({ success: true, data: mapping });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  static async getAllRateCards(req, res) {
    try {
      const rateCards = await RecRateCard.getAll();
      res.json({ success: true, data: rateCards });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async getCustomerMappings(req, res) {
    try {
      const mappings = await RecRateCard.getCustomerMappings();
      res.json({ success: true, data: mappings });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

module.exports = RecRateCardController;

