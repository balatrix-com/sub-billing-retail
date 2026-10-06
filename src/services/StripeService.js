const Stripe = require('stripe');
const dotenv = require('dotenv');

dotenv.config();

class StripeService {
    constructor() {
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('STRIPE_SECRET_KEY is not configured in environment');
        }
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    }

    /**
     * Create a Stripe Checkout Session for payment
     * @param {Object} params - Payment parameters
     * @returns {Object} Checkout session object
     */
    async createCheckoutSession({
        customer_id,
        amount,
        currency = 'usd',
        description,
        success_url,
        cancel_url,
        metadata = {}
    }) {
        try {
            // Amount should be in cents for Stripe
            const amountInCents = Math.round(amount * 100);

            const session = await this.stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [
                    {
                        price_data: {
                            currency: currency.toLowerCase(),
                            product_data: {
                                name: description || 'Wallet Top-up',
                                description: `Payment for customer ${customer_id}`,
                            },
                            unit_amount: amountInCents,
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                success_url: success_url,
                cancel_url: cancel_url,
                client_reference_id: customer_id,
                metadata: {
                    customer_id,
                    ...metadata
                },
                expires_at: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours from now
            });

            return {
                session_id: session.id,
                checkout_url: session.url,
                payment_intent: session.payment_intent,
                expires_at: new Date(session.expires_at * 1000),
                status: session.status,
            };
        } catch (error) {
            console.error('[StripeService] Error creating checkout session:', error.message);
            throw new Error(`Stripe checkout session creation failed: ${error.message}`);
        }
    }

    /**
     * Retrieve a Stripe Checkout Session
     * @param {string} sessionId - Stripe session ID
     * @returns {Object} Session details
     */
    async retrieveSession(sessionId) {
        try {
            const session = await this.stripe.checkout.sessions.retrieve(sessionId);

            return {
                session_id: session.id,
                payment_intent: session.payment_intent,
                payment_status: session.payment_status,
                amount_total: session.amount_total / 100, // Convert cents to dollars
                currency: session.currency,
                customer_id: session.client_reference_id,
                metadata: session.metadata,
                status: session.status,
            };
        } catch (error) {
            console.error('[StripeService] Error retrieving session:', error.message);
            throw new Error(`Failed to retrieve Stripe session: ${error.message}`);
        }
    }

    /**
     * Retrieve a Payment Intent
     * @param {string} paymentIntentId - Stripe payment intent ID
     * @returns {Object} Payment intent details
     */
    async retrievePaymentIntent(paymentIntentId) {
        try {
            const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

            return {
                id: paymentIntent.id,
                amount: paymentIntent.amount / 100,
                currency: paymentIntent.currency,
                status: paymentIntent.status,
                charges: paymentIntent.charges.data.map(charge => ({
                    id: charge.id,
                    amount: charge.amount / 100,
                    status: charge.status,
                })),
            };
        } catch (error) {
            console.error('[StripeService] Error retrieving payment intent:', error.message);
            throw new Error(`Failed to retrieve payment intent: ${error.message}`);
        }
    }

    /**
     * Verify Stripe webhook signature
     * @param {string} payload - Raw request body
     * @param {string} signature - Stripe signature header
     * @returns {Object} Verified webhook event
     */
    verifyWebhookSignature(payload, signature) {
        try {
            const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

            if (!webhookSecret) {
                throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
            }

            console.log(`[StripeService] Verifying signature.`);
            console.log(`[StripeService] Payload type: ${typeof payload}, Length: ${payload?.length || 0}`);
            if (Buffer.isBuffer(payload)) {
              console.log(`[StripeService] Payload is a Buffer. First 20 bytes: ${payload.toString('utf8', 0, 20)}...`);
            }
            console.log(`[StripeService] Signature header: ${signature?.substring(0, 30)}...`);
            console.log(`[StripeService] Using secret starts with: ${webhookSecret?.substring(0, 10)}...`);

            const event = this.stripe.webhooks.constructEvent(
                payload,
                signature,
                webhookSecret
            );

            return event;
        } catch (error) {
            console.error('[StripeService] Webhook signature verification failed:', error.message);
            throw new Error(`Webhook verification failed: ${error.message}`);
        }
    }

    /**
     * Create a refund for a payment
     * @param {string} paymentIntentId - Stripe payment intent ID
     * @param {number} amount - Amount to refund (optional, full refund if not specified)
     * @returns {Object} Refund details
     */
    async createRefund(paymentIntentId, amount = null) {
        try {
            const refundData = {
                payment_intent: paymentIntentId,
            };

            if (amount) {
                refundData.amount = Math.round(amount * 100); // Convert to cents
            }

            const refund = await this.stripe.refunds.create(refundData);

            return {
                refund_id: refund.id,
                amount: refund.amount / 100,
                status: refund.status,
                reason: refund.reason,
            };
        } catch (error) {
            console.error('[StripeService] Error creating refund:', error.message);
            throw new Error(`Refund creation failed: ${error.message}`);
        }
    }

    /**
     * List payment methods for a customer
     * @param {string} customerId - Sub Billing customer ID
     * @returns {Array} List of payment methods
     */
    async listPaymentMethods(customerId) {
        try {
            // 1. Get the Stripe Customer ID from our DB (this should be handled by a caller or we fetch it here)
            // For now, let's assume we are passed the Sub Billing ID and we need the Stripe ID.
            // But wait, the metadata on checkout session already has customer_id.
            
            // To be robust, let's fetch the customer from Stripe by email or metadata if not provided.
            // Actually, StripeService.js is low level. Let's add a method to find customer by metadata.
            
            const customers = await this.stripe.customers.search({
                query: `metadata['customer_id']:'${customerId}'`,
            });

            if (customers.data.length === 0) {
                return [];
            }

            const stripeCustomerId = customers.data[0].id;
            const paymentMethods = await this.stripe.paymentMethods.list({
                customer: stripeCustomerId,
                type: 'card',
            });

            return paymentMethods.data.map(pm => ({
                id: pm.id,
                brand: pm.card.brand,
                last4: pm.card.last4,
                exp_month: pm.card.exp_month,
                exp_year: pm.card.exp_year,
                is_default: customers.data[0].invoice_settings.default_payment_method === pm.id
            }));
        } catch (error) {
            console.error('[StripeService] Error listing payment methods:', error.message);
            return [];
        }
    }
}

module.exports = new StripeService();
