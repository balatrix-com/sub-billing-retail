# DB Data Flow (Payment Lifecycle)

## Tables touched by payment flow
- `payments`
- `payment_transactions`
- `payment_webhooks`
- `customer_wallets`
- `wallet_transactions`

## On Initiate (`/api/payments/initiate`)
### `payments` INSERT
- `id` (uuid)
- `payment_id` (PAY-...)
- `transaction_id` (currently same as payment_id)
- `customer_id`
- `amount`
- `currency` (`usd` expected in this deployment)
- `status` = `pending`
- `payment_method` = `stripe`
- `gateway` = `stripe`
- `stripe_session_id`
- `stripe_payment_intent_id` (may be null early)
- `success_url`, `cancel_url`, `description`, `metadata`, `expires_at`

### `payment_transactions` INSERT
- `transaction_type` = `session_created`
- `status` = `success`
- `gateway_response` = stripe session json

## On Webhook Success (`checkout.session.completed`)
### `payment_webhooks` INSERT
- `webhook_id` = stripe event id
- `event_type` = `checkout.session.completed`
- `payload` json
- `status` = `received`

### `payments` UPDATE
- `status` -> `completed`
- `stripe_payment_intent_id` set
- `completed_at` set
- `updated_at` set

### `customer_wallets` UPDATE
- `fiat_balance = fiat_balance + amount`
- `version = version + 1`
- `last_updated = now()`

### `wallet_transactions` INSERT
- `transaction_type` = `payment`
- `reference` = payment_id
- `before_balance`, `after_balance`

### `payment_transactions` INSERT (two rows)
- `webhook_received`
- `wallet_credited`

### `payment_webhooks` UPDATE
- `status` -> `processed`
- `processed_at` set
- `payment_id` linked

## Quick verification SQL
```sql
SELECT payment_id, status, stripe_session_id, completed_at
FROM payments
ORDER BY created_at DESC
LIMIT 5;
```

```sql
SELECT transaction_type, status, amount, created_at
FROM payment_transactions
ORDER BY created_at DESC
LIMIT 20;
```

```sql
SELECT event_type, status, payment_id, processed_at, error_message
FROM payment_webhooks
ORDER BY created_at DESC
LIMIT 10;
```

```sql
SELECT customer_id, fiat_balance, version, last_updated
FROM customer_wallets
WHERE customer_id = 'U0002';
```
