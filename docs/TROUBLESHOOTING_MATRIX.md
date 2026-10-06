# Troubleshooting Matrix

## Payment stuck in pending
Likely causes:
- Webhook not received
- Signature verification failed
- Session id mismatch (`data.object.id` vs `payments.stripe_session_id`)
- DB permission/schema error during webhook processing

Checks:
- App logs for webhook handler messages
- `payment_webhooks` latest rows
- `payments` status and timestamps

## Permission denied for table
Likely cause:
- App DB user missing grants

Fix:
- Apply table/sequence/schema grants for app DB user

## Port unreachable
Likely causes:
- App process not running
- Restart script killed process
- Wrong port in request (5000 vs 5005)

Checks:
- process list
- app log tail
- `/health` endpoint

## Background dev process crashes with EBADF
Likely cause:
- Running nodemon (`npm run dev`) under nohup detached mode

Fix:
- For background use `npm start`
- For live debug use foreground `npm run dev`

## Webhook returns 400
Likely causes:
- Missing `stripe-signature`
- Invalid signature due to wrong webhook secret
- Modified payload after signature creation

Checks:
- Confirm exact same payload used for HMAC generation and curl body
- Confirm `STRIPE_WEBHOOK_SECRET` matches app environment
