const PlanModel = require('../models/Plan');

class PlanController {
  // Create a new plan
  static async createPlan(req, res) {
    try {
      const {
        plan_id,
        name,
        amount,
        currency,
        validity_months,
        rate_card_id,
        numbers,
        extensions,
        monitoring_extensions,
        metadata,
        system_plan_id,
        setup_fees
      } = req.body;

      const plan = await PlanModel.create({
        plan_id,
        name,
        amount,
        currency,
        validity_months,
        rate_card_id,
        numbers,
        extensions,
        monitoring_extensions,
        metadata,
        system_plan_id,
        setup_fees
      });

      res.status(201).json({
        success: true,
        message: 'Plan created successfully',
        data: plan
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get plan by ID
  static async getPlan(req, res) {
    try {
      const { planId } = req.params;
      const plan = await PlanModel.findById(planId);

      if (!plan) {
        return res.status(404).json({
          success: false,
          message: 'Plan not found'
        });
      }

      res.status(200).json({
        success: true,
        data: plan
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get all plans
  static async getAllPlans(req, res) {
    try {
      const plans = await PlanModel.getAll();

      res.status(200).json({
        success: true,
        data: plans
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Update plan
  static async updatePlan(req, res) {
    try {
      const { planId } = req.params;
      const updateData = req.body;

      const plan = await PlanModel.update(planId, updateData);

      if (!plan) {
        return res.status(404).json({
          success: false,
          message: 'Plan not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Plan updated successfully',
        data: plan
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Delete plan
  static async deletePlan(req, res) {
    try {
      const { planId } = req.params;
      const result = await PlanModel.delete(planId);

      if (!result) {
        return res.status(404).json({
          success: false,
          message: 'Plan not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Plan deleted successfully',
        data: result
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        message: error.message
      });
    }
  }
}

module.exports = PlanController;
