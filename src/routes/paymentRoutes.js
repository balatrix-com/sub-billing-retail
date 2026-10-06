const express = require('express');
const PaymentController = require('../controllers/PaymentController');

const router = express.Router();

// Initiate payment
router.post('/initiate', PaymentController.initiatePayment);

// Get payment status
router.get('/:payment_id/status', PaymentController.getPaymentStatus);

// Payment success/cancel redirects
router.get('/success', PaymentController.handlePaymentSuccess);
router.get('/cancel', PaymentController.handlePaymentCancel);

// Stripe webhook (raw body needed for signature verification)
router.post('/webhook/stripe', PaymentController.handleStripeWebhook);

// Get payment history
router.get('/customer/:customer_id/history', PaymentController.getPaymentHistory);

// Cancel payment
router.post('/:payment_id/cancel', PaymentController.cancelPayment);

// Record manual payment
router.post('/manual', PaymentController.recordManualPayment);

// Get all payment details
router.get('/details', PaymentController.getAllPaymentDetails);

// Get payment details by customer ID
router.get('/details/customer/:customer_id', PaymentController.getPaymentDetailsByCustomerId);

// Top-up wallet with debt recovery
router.post('/topup', PaymentController.topupWalletWithDebtRecovery);

module.exports = router;
