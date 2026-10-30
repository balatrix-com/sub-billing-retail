BEGIN;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archive_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS customer_live_email ON customers(lower(admin_email)) WHERE lifecycle_status='ACTIVE';
CREATE TABLE IF NOT EXISTS customer_lifecycle_history (
  id bigserial PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(customer_id),
  event text NOT NULL,
  actor_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION guard_archived_customer_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text;
BEGIN
  SELECT lifecycle_status INTO current_state FROM customers WHERE customer_id=NEW.customer_id FOR SHARE;
  IF current_state='ARCHIVED' AND NEW.status IN ('active','grace','pending_activation') THEN
    RAISE EXCEPTION 'Archived customer cannot activate or renew subscriptions';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS archived_customer_subscription_guard ON subscriptions;
CREATE TRIGGER archived_customer_subscription_guard BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION guard_archived_customer_subscription();
COMMIT;
