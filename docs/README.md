# Subscription Billing Docs

This folder contains project context, architecture, API examples, database behavior, and operations notes.

## Start Here
- `PROJECT_OVERVIEW.md`: high-level system summary
- `ARCHITECTURE.md`: code layout and service responsibilities
- `API_REFERENCE.md`: endpoint catalog and curl examples
- `PAYMENT_FLOW.md`: end-to-end payment + webhook lifecycle
- `DB_DATA_FLOW.md`: table-by-table inserts/updates for payment flow
- `OPERATIONS_RUNBOOK.md`: deployment, restart, logs, troubleshooting
- `AI_HANDOFF_CONTEXT.md`: quick context for future AI sessions
- `TEST_CHECKLIST.md`: regression checks after changes
- `TROUBLESHOOTING_MATRIX.md`: symptom -> root cause -> checks
- `SCHEMA_DELTA_LOG.md`: manual DB patch history to migrate later

## Runtime Notes
- App host: `10.10.0.8`
- DB host: `10.10.0.7`
- Main API port: `5000` (some old examples use `5005`)
- Payment gateway: Stripe Checkout + webhook verification
