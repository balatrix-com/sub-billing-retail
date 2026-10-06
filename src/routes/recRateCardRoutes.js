const express = require('express');
const RecRateCardController = require('../controllers/RecRateCardController');

const router = express.Router();

// Customer specific mappings
router.get('/mappings', RecRateCardController.getCustomerMappings);
router.get('/customer/:custId', RecRateCardController.getCustomerRateCard);
router.put('/customer/:custId', RecRateCardController.updateCustomerRateCard);

// Rate Cards CRUD
router.get('/', RecRateCardController.getAllRateCards);
router.put('/:id', RecRateCardController.updateRateCard);

module.exports = router;
