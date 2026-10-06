const express = require('express');
const PlanController = require('../controllers/PlanController');

const router = express.Router();

// Create a new plan
router.post('/', PlanController.createPlan);

// Get all plans
router.get('/', PlanController.getAllPlans);

// Get plan by ID
router.get('/:planId', PlanController.getPlan);

// Update plan
router.put('/:planId', PlanController.updatePlan);

// Delete plan
router.delete('/:planId', PlanController.deletePlan);

module.exports = router;
