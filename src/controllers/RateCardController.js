const RateCard = require('../models/RateCard');
const CacheRefreshService = require('../services/CacheRefreshService');

class RateCardController {
  static async getAllRateCards(req, res) {
    try {
      const rateCards = await RateCard.getAll();
      res.json({ success: true, data: rateCards });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async getRateCard(req, res) {
    try {
      const rateCard = await RateCard.getById(req.params.id);
      if (!rateCard) {
        return res.status(404).json({ success: false, message: 'Rate card not found' });
      }
      res.json({ success: true, data: rateCard });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async createRateCard(req, res) {
    try {
      const rateCard = await RateCard.create(req.body);
      CacheRefreshService.triggerStandardRefresh();
      res.status(201).json({ success: true, data: rateCard });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  static async updateRateCard(req, res) {
    try {
      const rateCard = await RateCard.update(req.params.id, req.body);
      if (!rateCard) {
        return res.status(404).json({ success: false, message: 'Rate card not found' });
      }
      CacheRefreshService.triggerStandardRefresh();
      res.json({ success: true, data: rateCard });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  static async getCustomerMappings(req, res) {
    try {
      const mappings = await RateCard.getCustomerMappings();
      res.json({ success: true, data: mappings });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  static async updateCustomerMapping(req, res) {
    try {
      const { customer_id, ratecard_id } = req.body;
      if (!customer_id || !ratecard_id) {
        return res.status(400).json({ success: false, message: 'customer_id and ratecard_id are required' });
      }
      const mapping = await RateCard.updateCustomerMapping(customer_id, ratecard_id);
      CacheRefreshService.triggerStandardRefresh();
      res.json({ success: true, data: mapping });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }
}

module.exports = RateCardController;

