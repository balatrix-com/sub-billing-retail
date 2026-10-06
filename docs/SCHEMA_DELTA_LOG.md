# Schema Delta Log

Track non-migration manual schema patches done in environments.

## Why this file
Several runtime fixes were applied directly in DB during debugging. Keep them listed here until they are migrated formally.

## Known historical patches
- Added missing columns expected by payment code in `payments`
  - examples seen: `payment_id`, `status`, `stripe_session_id`, `stripe_payment_intent_id`, `stripe_charge_id`, `description`, `metadata`, `expires_at`, `completed_at`, `updated_at`, `transaction_id`, `gateway`
- Ensured currency compatibility with enum values (`usd`, `cad` lowercase)

## Permissions patches
Applied grants for app DB user (example user: `bill_eng1`):
- `USAGE` on schema `public`
- `SELECT, INSERT, UPDATE, DELETE` on all tables in schema `public`
- `USAGE, SELECT, UPDATE` on all sequences in schema `public`

## Action item
Convert all environment-only manual schema updates into explicit migration scripts so fresh environments are reproducible.
