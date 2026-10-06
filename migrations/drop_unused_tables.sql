-- =============================================
-- Drop Unused Tables from bala_billing
-- Date: 2026-08-26
-- =============================================
-- Tables confirmed unused (0 rows, not referenced in any code):
--   _prisma_migrations, analytics_state, metrics_job_state
--   sales_quote_*, sales_users
--
-- KEPT: live_call_events (still needed)
-- KEPT: demo_accounts, demo_activity_logs, demo_number_pool (pending manager confirmation)
-- KEPT: transactions (actively used by billing CDR processor)
-- =============================================

BEGIN;

DROP TABLE IF EXISTS _prisma_migrations CASCADE;
DROP TABLE IF EXISTS analytics_state CASCADE;
DROP TABLE IF EXISTS metrics_job_state CASCADE;
DROP TABLE IF EXISTS sales_quote_events CASCADE;
DROP TABLE IF EXISTS sales_quote_finalizations CASCADE;
DROP TABLE IF EXISTS sales_quote_items CASCADE;
DROP TABLE IF EXISTS sales_quote_customer_details CASCADE;
DROP TABLE IF EXISTS sales_quotes CASCADE;
DROP TABLE IF EXISTS sales_users CASCADE;

COMMIT;
