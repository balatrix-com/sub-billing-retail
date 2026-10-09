ALTER TABLE plans ADD COLUMN IF NOT EXISTS plan_category text NOT NULL DEFAULT 'base';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS duration_unit text NOT NULL DEFAULT 'months';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS duration_count integer;
UPDATE plans SET duration_count = GREATEST(COALESCE(validity_months,1),1) WHERE duration_count IS NULL;
ALTER TABLE subscriptions ALTER COLUMN status DROP DEFAULT;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='subscriptions' AND column_name='status' AND data_type<>'text') THEN
  ALTER TABLE subscriptions ALTER COLUMN status TYPE text USING status::text;
 END IF;
END $$;
ALTER TABLE subscriptions ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS subscription_type text NOT NULL DEFAULT 'base';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS end_date timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS duration_unit text NOT NULL DEFAULT 'months';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS duration_count integer NOT NULL DEFAULT 1;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS entitlement_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_price numeric(14,6) NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency_snapshot text NOT NULL DEFAULT 'usd';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS frozen_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_renewal_attempt_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS parent_subscription_id uuid REFERENCES subscriptions(id);
UPDATE subscriptions s SET end_date=COALESCE(s.end_date,s.next_billing,s.start_date + make_interval(months=>GREATEST(p.validity_months,1))),
 duration_count=GREATEST(COALESCE(p.validity_months,1),1), renewal_price=p.amount, currency_snapshot=p.currency::text,
 entitlement_snapshot=jsonb_build_object('numbers',COALESCE(p.numbers,0),'extensions',COALESCE(p.extensions,0),'monitoring_extensions',COALESCE(p.monitoring_extensions,0),'storage_gb',0)
FROM plans p WHERE p.plan_id=s.plan_id AND s.entitlement_snapshot='{}'::jsonb;
UPDATE subscriptions SET status='frozen',frozen_at=COALESCE(frozen_at,now()) WHERE status='suspended';
CREATE UNIQUE INDEX IF NOT EXISTS subscription_one_base_live ON subscriptions(customer_id)
 WHERE subscription_type='base' AND status IN ('active','grace','pending_activation');

CREATE TABLE IF NOT EXISTS subscription_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid NOT NULL REFERENCES subscriptions(id),
 event text NOT NULL, actor_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscription_operations (
 operation_key text PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES subscriptions(id),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscription_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid NOT NULL REFERENCES subscriptions(id),
 action text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE INDEX IF NOT EXISTS subscription_outbox_pending ON subscription_outbox(created_at) WHERE delivered_at IS NULL;

-- Keep legacy activation paths compatible while new APIs own lifecycle changes.
CREATE OR REPLACE FUNCTION initialize_subscription_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p plans%ROWTYPE;
BEGIN
 SELECT * INTO p FROM plans WHERE plan_id=NEW.plan_id;
 IF NEW.entitlement_snapshot='{}'::jsonb THEN
  NEW.entitlement_snapshot=jsonb_build_object('numbers',COALESCE(p.numbers,0),'extensions',COALESCE(p.extensions,0),'monitoring_extensions',COALESCE(p.monitoring_extensions,0),'storage_gb',0);
  NEW.subscription_type=p.plan_category;
  NEW.duration_unit=p.duration_unit;
  NEW.duration_count=COALESCE(p.duration_count,p.validity_months,1);
  NEW.renewal_price=p.amount;
  NEW.currency_snapshot=p.currency::text;
 END IF;
 NEW.end_date=COALESCE(NEW.end_date,NEW.next_billing,NEW.start_date + make_interval(months=>GREATEST(p.validity_months,1)));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS subscriptions_lifecycle_init ON subscriptions;
CREATE TRIGGER subscriptions_lifecycle_init BEFORE INSERT ON subscriptions FOR EACH ROW EXECUTE FUNCTION initialize_subscription_lifecycle();

-- Existing paid resource bundles become independently managed capacity subscriptions.
INSERT INTO subscriptions(id,subscription_id,customer_id,plan_id,status,start_date,next_billing,end_date,auto_renew,
 subscription_type,parent_subscription_id,duration_unit,duration_count,renewal_price,currency_snapshot,entitlement_snapshot)
SELECT sa.id,'CAP-'||sa.id::text,s.customer_id,s.plan_id,s.status,sa.start_date,s.next_billing,s.end_date,s.auto_renew,
 'capacity',s.id,s.duration_unit,s.duration_count,sa.quantity*sa.unit_price,s.currency_snapshot,
 jsonb_build_object('numbers',CASE WHEN sac.resource_type IN ('did','tfn') THEN sa.quantity*sac.units_count ELSE 0 END,
 'extensions',CASE WHEN sac.resource_type='extension' THEN sa.quantity*sac.units_count ELSE 0 END,
 'monitoring_extensions',CASE WHEN sac.resource_type='monitoring_extension' THEN sa.quantity*sac.units_count ELSE 0 END,'storage_gb',0)
FROM subscription_addons sa JOIN subscriptions s ON s.id=sa.subscription_id
JOIN subscription_addons_catalog sac ON sac.addon_id=sa.addon_id
WHERE sa.status='active' AND sac.resource_type IN ('extension','monitoring_extension','did','tfn')
ON CONFLICT(id) DO NOTHING;
UPDATE extension_assets a SET subscription_id=sa.id,subscription_addon_id=NULL FROM subscription_addons sa
 WHERE a.subscription_addon_id=sa.id AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=sa.id AND s.subscription_type='capacity');
UPDATE subscription_addons sa SET status='migrated',updated_at=now()
 WHERE EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=sa.id AND s.subscription_type='capacity');
