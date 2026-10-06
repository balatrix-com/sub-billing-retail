# Payment Flow (End-to-End)

## Step A: Initiate Payment
Endpoint: `POST /api/payments/initiate`

What happens:
1. Validate customer exists
2. Generate internal `payment_id` (e.g., `PAY-2603-4821`)
3. Create Stripe Checkout session
4. Insert pending payment row
5. Insert `session_created` payment transaction row

Result:
- API returns `payment_id`, `checkout_url`, `stripe_session_id`, `status=pending`

## Step B: Customer Pays in Stripe Checkout
Customer completes payment on Stripe-hosted page.

## Step C: Stripe Webhook
Endpoint: `POST /api/payments/webhook/stripe`

What happens:
1. Validate `stripe-signature` header using `STRIPE_WEBHOOK_SECRET`
2. Insert webhook audit row with status `received`
3. Lookup payment by `stripe_session_id`
4. If payment already completed -> ignore
5. Update payment to `completed` and set `completed_at`
6. Credit customer wallet in DB transaction
7. Insert `webhook_received` + `wallet_credited` payment transaction rows
8. Mark webhook row `processed`

## Idempotency Behavior
If same completion webhook is received again:
- service sees `payments.status = completed`
- webhook is ignored safely

## Common Failure Points
- Signature mismatch (`STRIPE_WEBHOOK_SECRET` incorrect)
- Payload session id does not match `payments.stripe_session_id`
- Missing DB columns (`updated_at`, `completed_at`, etc.)
- Missing DB permissions for app DB user on `payment_transactions` or other tables

## Notes on IDs
- `payment_id`: internal readable ID
- `transaction_id` column currently duplicates `payment_id` in current implementation
- Stripe refs: `stripe_session_id`, `stripe_payment_intent_id`
