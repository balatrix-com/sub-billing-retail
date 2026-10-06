# Test Checklist

Use this checklist for quick regression validation after code/schema changes.

## Preflight
- App reachable at `/health`
- DB connection check endpoint responds
- App logs visible (`/tmp/sub.log` or foreground terminal)

## Customer Flow
- Create customer with valid payload returns 201
- Customer row created in `customers`
- Wallet row auto-created in `customer_wallets`

## Payment Flow
- `POST /api/payments/initiate` returns `payment_id` and `stripe_session_id`
- `payments` row created with status `pending`
- `payment_transactions` has `session_created`

## Webhook Flow
- Signed webhook request accepted (`{"received":true}`)
- `payment_webhooks` row inserted then marked `processed`
- `payments.status` changes to `completed`
- `customer_wallets.fiat_balance` increases by amount
- `wallet_transactions` row inserted with reference to payment id
- `payment_transactions` contains `webhook_received` and `wallet_credited`

## Negative Cases
- Missing `stripe-signature` returns 400
- Invalid signature returns 400
- Webhook with unknown session id is ignored safely

## Subscription & Asset Lifecycle
- `trigger-renewals` with insufficient balance marks subscription `suspended`
- Suspension correctly sets DID/Extension status to `inactive`
- `POST /api/subscriptions/:id/renew` with valid balance succeeds
- Manual renewal resets next billing date and grants free minutes
- Manual renewal reactivates assets (status `inactive` -> `active`)

## Permission Sanity
- App DB user can insert/update/select required payment tables
- No permission errors in logs for `payments`, `payment_transactions`, `payment_webhooks`, `wallet_transactions`, `customer_wallets`
