const PaymentService = require('../services/PaymentService');
const StripeService = require('../services/StripeService');
const http = require('http');
const https = require('https');
const RecordingGateService = require('../services/RecordingGateService');

function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
}

function safeHeaders(headers = {}) {
    const clone = { ...headers };
    if (clone.authorization) clone.authorization = '[redacted]';
    return clone;
}

class PaymentController {
    /**
     * POST /api/payments/initiate
     * Initiate a new payment
     */
    static async initiatePayment(req, res) {
        try {
            const { Initiate_by, customer_id, amount, currency, description, success_url, cancel_url, metadata } = req.body;

            // Handle origin-based redirection (Sales Dashboard)
            if (Initiate_by === 'sales') {
                return res.status(200).json({
                    success: true,
                    message: 'Redirecting to sales portal',
                    data: {
                        redirect_url: process.env.SALES_WEBHOOK || 'https://sales.ajaydl.com/payments/redirect' // Directly fetched from .env
                    }
                });
            }

            // Validation
            if (!customer_id || !amount) {
                return res.status(400).json({
                    success: false,
                    message: 'customer_id and amount are required'
                });
            }

            if (amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Amount must be greater than 0'
                });
            }

            const payment = await PaymentService.initiatePayment({
                customer_id,
                amount: parseFloat(amount),
                currency: currency || 'USD',
                description,
                success_url,
                cancel_url,
                metadata,
                origin: Initiate_by || 'Sub_billing'
            });

            res.status(200).json({
                success: true,
                data: payment
            });

        } catch (error) {
            console.error('[PaymentController] Error initiating payment:', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * GET /api/payments/:payment_id/status
     * Get payment status
     */
    static async getPaymentStatus(req, res) {
        try {
            const { payment_id } = req.params;

            const payment = await PaymentService.getPaymentStatus(payment_id);

            res.status(200).json({
                success: true,
                data: {
                    payment_id: payment.payment_id,
                    status: payment.status,
                    amount: payment.amount,
                    currency: payment.currency,
                    payment_method: payment.payment_method,
                    created_at: payment.created_at,
                    completed_at: payment.completed_at,
                    description: payment.description
                }
            });

        } catch (error) {
            console.error('[PaymentController] Error getting payment status:', error.message);
            res.status(404).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * GET /api/payments/success?session_id=xxx
     * Payment success redirect handler
     */
    static async handlePaymentSuccess(req, res) {
        try {
            const { session_id } = req.query;

            if (!session_id) {
                return res.status(400).json({
                    success: false,
                    message: 'session_id is required'
                });
            }

            // Retrieve session from Stripe
            const sessionDetails = await StripeService.retrieveSession(session_id);

            // Get payment from database
            const payment = await PaymentService.getPaymentStatus(session_id);

            res.status(200).json({
                success: true,
                message: 'Payment processing...',
                data: {
                    payment_id: payment.payment_id,
                    status: payment.status,
                    amount: payment.amount,
                    currency: payment.currency,
                    stripe_status: sessionDetails.payment_status,
                    note: payment.status === 'completed'
                        ? 'Payment completed. Funds added to wallet.'
                        : 'Payment is being processed. Funds will appear in wallet shortly.'
                }
            });

        } catch (error) {
            console.error('[PaymentController] Error handling success:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error processing payment success'
            });
        }
    }

    /**
     * GET /api/payments/cancel?session_id=xxx
     * Payment cancellation handler
     */
    static async handlePaymentCancel(req, res) {
        try {
            const { session_id } = req.query;

            if (!session_id) {
                return res.status(400).json({
                    success: false,
                    message: 'session_id is required'
                });
            }

            // Get payment from database
            const payment = await PaymentService.getPaymentStatus(session_id);

            // Update status if still pending
            if (payment.status === 'pending') {
                await PaymentService.cancelPayment(payment.payment_id);
            }

            res.status(200).json({
                success: true,
                message: 'Payment cancelled',
                data: {
                    payment_id: payment.payment_id,
                    status: 'cancelled'
                }
            });

        } catch (error) {
            console.error('[PaymentController] Error handling cancellation:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error processing payment cancellation'
            });
        }
    }

    /**
     * POST /api/payments/webhook/stripe
     * Handle Stripe webhooks
     */
    static async handleStripeWebhook(req, res) {
        try {
            console.log('[PaymentController] ===== STRIPE WEBHOOK START =====');
            console.log('[PaymentController] Method:', req.method, 'Path:', req.originalUrl);
            console.log('[PaymentController] Client IP:', getClientIp(req));
            console.log('[PaymentController] Content-Type:', req.headers['content-type']);
            console.log('[PaymentController] Content-Length:', req.headers['content-length']);
            console.log('[PaymentController] Headers:', JSON.stringify(safeHeaders(req.headers)));

            const signature = req.headers['stripe-signature'];

            if (!signature) {
                console.error('[PaymentController] Missing stripe-signature header');
                console.log('[PaymentController] ===== STRIPE WEBHOOK END (400) =====');
                return res.status(400).json({ error: 'Missing stripe-signature header' });
            }

            // Verify webhook signature
            console.log(`[PaymentController] req.rawBody exists: ${!!req.rawBody}`);
            console.log(`[PaymentController] req.rawBody is Buffer: ${Buffer.isBuffer(req.rawBody)}`);
            console.log(`[PaymentController] req.rawBody length: ${req.rawBody?.length || 0}`);
            const event = StripeService.verifyWebhookSignature(req.rawBody, signature);

            console.log(`[PaymentController] Received webhook: ${event.type}`);

            // Handle different event types
            const sessionData = event.data.object;
            const metadata = sessionData.metadata || {};

            // Route based on Initiate_by
            if (metadata.Initiate_by === 'sales') {
                console.log(`[PaymentController] Routing webhook to Sales Dashboard: ${event.type}`);
                
                const targetUrl = process.env.SALES_DASHBOARD_WEBHOOK_URL;
                if (!targetUrl) {
                    console.error('[PaymentController] SALES_DASHBOARD_WEBHOOK_URL not configured');
                    console.log('[PaymentController] ===== STRIPE WEBHOOK END (500) =====');
                    return res.status(500).json({ error: 'Routing target not configured' });
                }

                // Forward the webhook using fetch (supports both http and https)
                try {
                    console.log('[PaymentController] Forward target:', targetUrl);
                    const httpClient = targetUrl.startsWith('https://') ? https : http;
                    const reqForward = httpClient.request(targetUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Stripe-Signature': signature,
                            'Content-Length': req.rawBody.length
                        }
                    });

                    reqForward.on('response', (forwardRes) => {
                        let responseData = '';
                        forwardRes.on('data', (chunk) => {
                            responseData += chunk.toString();
                        });
                        forwardRes.on('end', () => {
                            console.log('[PaymentController] Forward response status:', forwardRes.statusCode);
                            console.log('[PaymentController] Forward response body:', responseData || '[empty]');
                        });
                    });

                    reqForward.on('error', (err) => {
                        console.error('[PaymentController] Error forwarding webhook:', err.message);
                    });

                    reqForward.write(req.rawBody);
                    reqForward.end();

                } catch (forwardError) {
                    console.error(`[PaymentController] Error forwarding webhook: ${forwardError.message}`);
                }

                console.log('[PaymentController] ===== STRIPE WEBHOOK END (200 routed) =====');
                return res.status(200).json({ received: true, routed: true });
            }

            // Handle Sub-billing events (or default)
            switch (event.type) {
                case 'checkout.session.completed':
                    await PaymentService.processSuccessfulPayment(event);
                    break;

                case 'checkout.session.expired':
                    console.log('[PaymentController] Checkout session expired:', event.data.object.id);
                    break;

                case 'payment_intent.payment_failed':
                    console.log('[PaymentController] Payment failed:', event.data.object.id);
                    break;

                default:
                    console.log(`[PaymentController] Unhandled event type: ${event.type}`);
            }

            console.log('[PaymentController] ===== STRIPE WEBHOOK END (200 local) =====');
            res.status(200).json({ received: true });

        } catch (error) {
            console.error('[PaymentController] Webhook error:', error.message);
            if (error?.stack) {
                console.error('[PaymentController] Webhook error stack:', error.stack);
            }
            console.log('[PaymentController] ===== STRIPE WEBHOOK END (400 error) =====');
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * GET /api/payments/customer/:customer_id/history
     * Get payment history for a customer
     */
    static async getPaymentHistory(req, res) {
        try {
            const { customer_id } = req.params;
            const limit = parseInt(req.query.limit) || 20;

            const history = await PaymentService.getPaymentHistory(customer_id, limit);

            res.status(200).json({
                success: true,
                data: history
            });

        } catch (error) {
            console.error('[PaymentController] Error getting payment history:', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * POST /api/payments/:payment_id/cancel
     * Cancel a pending payment
     */
    static async cancelPayment(req, res) {
        try {
            const { payment_id } = req.params;

            const result = await PaymentService.cancelPayment(payment_id);

            res.status(200).json({
                success: true,
                ...result
            });

        } catch (error) {
            console.error('[PaymentController] Error cancelling payment:', error.message);
            res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * POST /api/payments/manual
     * Record a manual payment
     */
    static async recordManualPayment(req, res) {
        try {
            const { customer_id, amount, currency, tx_id, payment_type, description } = req.body;

            // Validation
            if (!customer_id || !amount || !tx_id) {
                return res.status(400).json({
                    success: false,
                    message: 'customer_id, amount, and tx_id are required'
                });
            }

            const result = await PaymentService.recordManualPayment({
                customer_id,
                amount: parseFloat(amount),
                currency: currency || 'USD',
                tx_id,
                payment_type,
                description
            });

            res.status(200).json({
                success: true,
                data: result
            });

        } catch (error) {
            console.error('[PaymentController] Error recording manual payment:', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
    /**
     * GET /api/payments/details
     * Get all payment details
     */
    static async getAllPaymentDetails(req, res) {
        try {
            const details = await PaymentService.getAllPaymentDetails();
            res.status(200).json({
                success: true,
                data: details
            });
        } catch (error) {
            console.error('[PaymentController] Error getting all payment details:', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * GET /api/payments/details/customer/:customer_id
     * Get payment details by customer ID
     */
    static async getPaymentDetailsByCustomerId(req, res) {
        try {
            const { customer_id } = req.params;
            const details = await PaymentService.getPaymentDetailsByCustomerId(customer_id);
            res.status(200).json({
                success: true,
                data: details
            });
        } catch (error) {
            console.error('[PaymentController] Error getting payment details by customer ID:', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }

    /**
     * POST /api/v2/wallets/topup
     * Top-up wallet balance with automatic credit overdraft debt recovery
     */
    static async topupWalletWithDebtRecovery(req, res) {
        const pool = require('../config/database');
        const client = await pool.connect();

        try {
            const { customer_id, amount } = req.body;
            const topupAmount = Number(amount);

            if (!customer_id || !topupAmount || topupAmount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'customer_id and a positive amount are required'
                });
            }

            await client.query('BEGIN');

            const walletRes = await client.query(
                `SELECT * FROM customer_wallets WHERE customer_id = $1 FOR UPDATE;`,
                [customer_id]
            );

            if (!walletRes.rows[0]) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: 'Customer wallet not found' });
            }

            const wallet = walletRes.rows[0];
            const fiatBalance = Number(wallet.fiat_balance || 0);
            const creditLimit = Number(wallet.credit_limit || 0);
            const creditUsed = Number(wallet.credit_used || 0);

            // Step 1: Pay off credit overdraft debt first
            const creditPayoff = Math.min(topupAmount, creditUsed);
            const newCreditUsed = creditUsed - creditPayoff;
            const remainingTopup = topupAmount - creditPayoff;
            const newFiatBalance = fiatBalance + remainingTopup;
            const availablePurchasingPower = newFiatBalance + Math.max(0, creditLimit - newCreditUsed);

            await client.query(
                `UPDATE customer_wallets SET fiat_balance = $1, credit_used = $2, last_updated = NOW() WHERE customer_id = $3;`,
                [newFiatBalance, newCreditUsed, customer_id]
            );

            // Step 2: Auto-restore service if available purchasing power > 0
            let servicesRestored = false;
            if (availablePurchasingPower > 0) {
                const subUpdate = await client.query(
                    `UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE customer_id = $1 AND status IN ('suspended', 'past_due') RETURNING *;`,
                    [customer_id]
                );
                if (subUpdate.rows.length > 0) {
                    servicesRestored = true;
                }
            }

            await client.query('COMMIT');
            await RecordingGateService.sync(customer_id, {
                fiat_balance: newFiatBalance,
                credit_limit: creditLimit,
                credit_used: newCreditUsed
            });

            res.status(200).json({
                success: true,
                message: 'Wallet top-up processed successfully',
                topup_amount: topupAmount,
                credit_payoff_applied: creditPayoff,
                net_fiat_balance: newFiatBalance,
                credit_used: newCreditUsed,
                credit_limit: creditLimit,
                available_purchasing_power: availablePurchasingPower,
                services_restored: servicesRestored
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ success: false, message: error.message });
        } finally {
            client.release();
        }
    }
}

module.exports = PaymentController;
