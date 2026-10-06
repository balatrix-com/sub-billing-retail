# AI Handoff Context

Use this file to quickly bootstrap future support sessions.

## Current Working Assumptions
- Main API runs on `http://10.10.0.8:5000`
- DB is PostgreSQL on `10.10.0.7`
- Payment currency enum in DB uses lowercase values (`usd`, `cad`)
- Stripe webhook signature verification is enabled

## Important Project Facts
- Customer creation auto-creates wallet row
- Payment remains `pending` until webhook success processing completes
- Webhook processing updates payment + credits wallet + writes audit rows

## Important Files to Read First
- `src/server.js`
- `src/controllers/PaymentController.js`
- `src/services/PaymentService.js`
- `src/services/StripeService.js`
- `migrations/01_create_tables.sql`
- `migrations/02_create_payment_tables.sql`

## Typical Test Flow
1. Create customer (`/api/customers`)
2. Initiate payment (`/api/payments/initiate`)
3. Send signed webhook (`/api/payments/webhook/stripe`)
4. Verify DB rows in payments/payment_transactions/payment_webhooks/wallet tables

## Known Pitfalls Seen
- Wrong command typo: `url` vs `curl`
- Missing JSON comma in request body
- Background `nodemon` crash under nohup (`EBADF`)
- DB user lacking table permissions
- Missing schema columns (`updated_at`, etc.)

## 30-Second Startup Prompt (Copy/Paste)
Use this exact prompt at the start of a new AI session:

```text
Load project context from these docs first, then continue with implementation:
1) docs/AI_HANDOFF_CONTEXT.md
2) docs/PROJECT_OVERVIEW.md
3) docs/ARCHITECTURE.md
4) docs/API_REFERENCE.md
5) docs/PAYMENT_FLOW.md
6) docs/DB_DATA_FLOW.md
7) docs/OPERATIONS_RUNBOOK.md
8) docs/TEST_CHECKLIST.md
9) docs/TROUBLESHOOTING_MATRIX.md
10) docs/SCHEMA_DELTA_LOG.md

Environment:
- App host: 10.10.0.8
- DB host: 10.10.0.7
- API port: 5000

Primary goal:
- Keep payment lifecycle healthy: initiate -> webhook verify -> complete -> wallet credit.

Rules:
- Prefer minimal, safe changes.
- Validate with API + SQL checks after edits.
- If payment stays pending, inspect webhook logs and payment_webhooks table first.
```

## Fast Triage Prompt (When Something Is Broken)
```text
Use docs/TROUBLESHOOTING_MATRIX.md and docs/TEST_CHECKLIST.md first.
Then identify failure stage with evidence from:
1) app logs
2) payments
3) payment_webhooks
4) payment_transactions
5) customer_wallets/wallet_transactions

Return: root cause, exact fix, verification commands.
```
