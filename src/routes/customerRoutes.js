const express = require('express');
const CustomerController = require('../controllers/CustomerController');
const { validateCustomerCreation } = require('../middleware/validateCustomer');

const router = express.Router();

// Create a new customer with validation
router.post('/', validateCustomerCreation, CustomerController.createCustomer);

// Get all customers
router.get('/', CustomerController.getAllCustomers);

// Get customer by ID
router.get('/:customerId', CustomerController.getCustomer);

// Update customer
router.put('/:customerId', CustomerController.updateCustomer);

// Delete customer
router.delete('/:customerId', CustomerController.deleteCustomer);

// Get credit limit
router.get('/:customerId/credit-limit', CustomerController.getCreditLimit);

// Update credit limit
router.put('/:customerId/credit-limit', CustomerController.updateCreditLimit);

module.exports = router;
