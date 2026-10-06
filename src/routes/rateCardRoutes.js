const express = require('express');
const RateCardController = require('../controllers/RateCardController');

const router = express.Router();

// Mappings
router.get('/mappings', RateCardController.getCustomerMappings);
router.post('/mappings', RateCardController.updateCustomerMapping);

// Rate Cards CRUD
router.get('/', RateCardController.getAllRateCards);
router.get('/:id', RateCardController.getRateCard);
router.post('/', RateCardController.createRateCard);
router.put('/:id', RateCardController.updateRateCard);

module.exports = router;
