-- =============================================
-- 01: Core Billing Database Schema & Seeds
-- Fully Idempotent & Production Ready
-- =============================================

-- 1. ENUM types (Safe creation)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'customer_type_enum') THEN
        CREATE TYPE customer_type_enum AS ENUM ('individual', 'company');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'currency_enum') THEN
        CREATE TYPE currency_enum AS ENUM ('usd', 'cad');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'addon_charge_type') THEN
        CREATE TYPE addon_charge_type AS ENUM ('one_time', 'recurring', 'recurring_with_setup');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status_enum') THEN
        CREATE TYPE subscription_status_enum AS ENUM ('active', 'cancelled', 'suspended');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_tx_type') THEN
        CREATE TYPE wallet_tx_type AS ENUM ('payment', 'subscription', 'addon', 'refund', 'adjustment');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'free_mins_source_type') THEN
        CREATE TYPE free_mins_source_type AS ENUM ('plan', 'addon');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'free_mins_tx_type') THEN
        CREATE TYPE free_mins_tx_type AS ENUM ('grant', 'consume', 'expiry_purge', 'adjustment');
    END IF;
END $$;

-- 2. Customers
CREATE TABLE IF NOT EXISTS customers (
    customer_id TEXT PRIMARY KEY,
    fr_cusid TEXT UNIQUE NOT NULL,
    customer_type customer_type_enum NOT NULL,
    company_name TEXT,
    company_tax_id TEXT,
    first_name TEXT,
    last_name TEXT,
    admin_email TEXT NOT NULL,
    phone TEXT,
    address_st TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    currency currency_enum NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.5 Customer Wallets
CREATE TABLE IF NOT EXISTS customer_wallets (
    customer_id TEXT PRIMARY KEY REFERENCES customers(customer_id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL,
    fiat_balance NUMERIC(14,6) NOT NULL DEFAULT 0,
    free_seconds INTEGER NOT NULL DEFAULT 0,
    credit_limit NUMERIC(14,6) NOT NULL DEFAULT 0,
    credit_used NUMERIC(14,6) NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    version INTEGER NOT NULL DEFAULT 1
);

-- 3. Plans
CREATE TABLE IF NOT EXISTS plans (
    plan_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    currency currency_enum NOT NULL,
    validity_months INT NOT NULL,
    tfns INT NOT NULL DEFAULT 0,
    dids INT NOT NULL DEFAULT 0,
    free_mins INT NOT NULL DEFAULT 0,
    extensions INT NOT NULL DEFAULT 0,
    monitoring_per_user INT NOT NULL DEFAULT 0,
    system_plan_id VARCHAR(255),
    setup_fees DECIMAL(10,2) DEFAULT 0,
    rate_card_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Addons
CREATE TABLE IF NOT EXISTS addons (
    addon_id TEXT PRIMARY KEY,
    addon_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    charge_type addon_charge_type NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    currency currency_enum NOT NULL,
    interval_unit TEXT,
    interval_count INT DEFAULT 1,
    validity_months INT,
    setup_fee NUMERIC(10,2),
    is_active BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id TEXT NOT NULL UNIQUE,
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(plan_id),
    status subscription_status_enum NOT NULL DEFAULT 'active',
    start_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_billing TIMESTAMPTZ,
    rate_card_id TEXT,
    base_plan_price NUMERIC(14,6) NOT NULL DEFAULT 0,
    recurring_addons_price NUMERIC(14,6) NOT NULL DEFAULT 0,
    total_recurring_price NUMERIC(14,6) NOT NULL DEFAULT 0,
    target_plan_id TEXT REFERENCES plans(plan_id),
    scheduled_switch_at TIMESTAMPTZ,
    auto_renew BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5.2 Subscription Addons Catalog
CREATE TABLE IF NOT EXISTS subscription_addons_catalog (
    addon_id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    resource_type VARCHAR(32) NOT NULL CHECK (resource_type IN ('extension', 'tfn', 'did', 'supervisor', 'storage')),
    units_count INTEGER NOT NULL DEFAULT 1,
    unit_price NUMERIC(14, 6) NOT NULL CHECK (unit_price >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5.3 Subscription Addons
CREATE TABLE IF NOT EXISTS subscription_addons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    addon_id TEXT NOT NULL REFERENCES subscription_addons_catalog(addon_id) ON DELETE CASCADE,
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    status TEXT NOT NULL DEFAULT 'active',
    purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    start_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_billing TIMESTAMPTZ,
    cancelled_date TIMESTAMPTZ,
    total_setup_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_recurring_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
    unit_price NUMERIC(14,6) DEFAULT 0,
    prorated_charge_paid NUMERIC(14,6) DEFAULT 0,
    resource_type VARCHAR(32) DEFAULT 'extension',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_addons_subscription ON subscription_addons(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_addons_addon ON subscription_addons(addon_id);
CREATE INDEX IF NOT EXISTS idx_subscription_addons_status ON subscription_addons(status);

-- 5.4 TFN Assets
CREATE TABLE IF NOT EXISTS tfn_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT,
    subscription_addon_id UUID REFERENCES subscription_addons(id) ON DELETE SET NULL,
    tfn_number TEXT UNIQUE,
    tfn_name TEXT,
    status TEXT NOT NULL DEFAULT 'unassigned',
    assigned_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_date TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tfn_customer ON tfn_assets(customer_id);
CREATE INDEX IF NOT EXISTS idx_tfn_subscription ON tfn_assets(subscription_id);
CREATE INDEX IF NOT EXISTS idx_tfn_source ON tfn_assets(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_tfn_status ON tfn_assets(status);

-- 5.5 DID Assets
CREATE TABLE IF NOT EXISTS did_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT,
    subscription_addon_id UUID REFERENCES subscription_addons(id) ON DELETE SET NULL,
    did_number TEXT UNIQUE,
    did_name TEXT,
    status TEXT NOT NULL DEFAULT 'unassigned',
    assigned_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_date TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_did_customer ON did_assets(customer_id);
CREATE INDEX IF NOT EXISTS idx_did_subscription ON did_assets(subscription_id);
CREATE INDEX IF NOT EXISTS idx_did_source ON did_assets(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_did_status ON did_assets(status);

-- 5.6 Extension Assets
CREATE TABLE IF NOT EXISTS extension_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT,
    subscription_addon_id UUID REFERENCES subscription_addons(id) ON DELETE SET NULL,
    extension_number TEXT NOT NULL,
    extension_name TEXT,
    extension_type TEXT DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    assigned_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_date TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(customer_id, subscription_id, extension_number)
);

CREATE INDEX IF NOT EXISTS idx_ext_customer ON extension_assets(customer_id);
CREATE INDEX IF NOT EXISTS idx_ext_subscription ON extension_assets(subscription_id);
CREATE INDEX IF NOT EXISTS idx_ext_source ON extension_assets(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ext_status ON extension_assets(status);

-- 5.7 Monitoring Assets
CREATE TABLE IF NOT EXISTS monitoring_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT,
    subscription_addon_id UUID REFERENCES subscription_addons(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL UNIQUE,
    user_name TEXT NOT NULL,
    user_email TEXT NOT NULL,
    user_phone TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    assigned_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_date TIMESTAMPTZ,
    can_monitor_all BOOLEAN DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_customer ON monitoring_assets(customer_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_subscription ON monitoring_assets(subscription_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_source ON monitoring_assets(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_status ON monitoring_assets(status);
CREATE INDEX IF NOT EXISTS idx_monitoring_email ON monitoring_assets(user_email);

-- 6. Invoices
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL,
    currency currency_enum NOT NULL,
    invoice_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_date TIMESTAMPTZ,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. Wallet Transactions
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL CHECK (amount <> 0),
    currency currency_enum NOT NULL,
    before_balance NUMERIC(10,2) NOT NULL,
    after_balance NUMERIC(10,2) NOT NULL,
    transaction_type wallet_tx_type NOT NULL DEFAULT 'payment',
    reference TEXT,
    gateway TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. Free Mins Grants
CREATE TABLE IF NOT EXISTS free_mins_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    source_type free_mins_source_type NOT NULL,
    source_id TEXT NOT NULL,
    granted_secs INT NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. Free Mins Transactions
CREATE TABLE IF NOT EXISTS free_mins_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    free_mins_grant_id UUID REFERENCES free_mins_grants(id) ON DELETE CASCADE,
    amount_secs INT NOT NULL,
    transaction_type free_mins_tx_type NOT NULL,
    reference TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10. Rate Cards (Standard Call Rate Cards)
CREATE TABLE IF NOT EXISTS rate_cards (
    ratecard_id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    country TEXT,
    in_rate_per_min NUMERIC(14,6) NOT NULL DEFAULT 0,
    in_rate_per_sec NUMERIC(14,8),
    in_initial_increment_sec INTEGER NOT NULL DEFAULT 60,
    in_increment_sec INTEGER NOT NULL DEFAULT 60,
    ob_rate_per_min NUMERIC(14,6) NOT NULL DEFAULT 0,
    ob_rate_per_sec NUMERIC(14,8),
    ob_initial_increment_sec INTEGER NOT NULL DEFAULT 60,
    ob_increment_sec INTEGER NOT NULL DEFAULT 60,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column check for existing rate_cards tables
ALTER TABLE rate_cards ADD COLUMN IF NOT EXISTS in_rate_per_sec NUMERIC(14,8);
ALTER TABLE rate_cards ADD COLUMN IF NOT EXISTS ob_rate_per_sec NUMERIC(14,8);
UPDATE rate_cards SET in_rate_per_sec = ROUND(in_rate_per_min / 60.0, 8) WHERE in_rate_per_sec IS NULL AND in_rate_per_min IS NOT NULL;
UPDATE rate_cards SET ob_rate_per_sec = ROUND(ob_rate_per_min / 60.0, 8) WHERE ob_rate_per_sec IS NULL AND ob_rate_per_min IS NOT NULL;

-- Seed Default Standard Rate Cards so ratecard_id = 2 (default) always exists
INSERT INTO rate_cards (ratecard_id, name, currency, in_rate_per_min, in_rate_per_sec, ob_rate_per_min, ob_rate_per_sec)
VALUES 
    (1, 'Standard_Global', 'USD', 0.0020, 0.00003333, 0.0080, 0.00013333),
    (2, 'Default Rate Card', 'USD', 0.0100, 0.00016667, 0.0050, 0.00008333),
    (3, 'Premium Rate Card', 'USD', 0.0150, 0.00025000, 0.0100, 0.00016667)
ON CONFLICT (ratecard_id) DO UPDATE
SET in_rate_per_sec = COALESCE(rate_cards.in_rate_per_sec, EXCLUDED.in_rate_per_sec),
    ob_rate_per_sec = COALESCE(rate_cards.ob_rate_per_sec, EXCLUDED.ob_rate_per_sec);

SELECT setval(pg_get_serial_sequence('rate_cards', 'ratecard_id'), COALESCE((SELECT MAX(ratecard_id) FROM rate_cards), 1));

-- 11. Customer Rate Card Mapping
CREATE TABLE IF NOT EXISTS customer_ratecard (
    customer_id TEXT PRIMARY KEY REFERENCES customers(customer_id) ON DELETE CASCADE,
    ratecard_id BIGINT NOT NULL REFERENCES rate_cards(ratecard_id) ON DELETE CASCADE,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column check for existing customer_ratecard tables
ALTER TABLE customer_ratecard ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE customer_ratecard ADD COLUMN IF NOT EXISTS effective_to TIMESTAMPTZ;
ALTER TABLE customer_ratecard ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 12. Recording Rate Cards
CREATE TABLE IF NOT EXISTS rec_rate_card (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    rate_per_min NUMERIC(14,6) NOT NULL DEFAULT 0,
    retention_period INTEGER NOT NULL DEFAULT 7,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Default Recording Rate Cards (7, 15, 30 days)
INSERT INTO rec_rate_card (id, name, currency, rate_per_min, retention_period)
VALUES 
    (1, '7_Days_Standard', 'USD', 0.0020, 7),
    (2, '15_Days_Standard', 'USD', 0.0050, 15),
    (3, '30_Days_Standard', 'USD', 0.0080, 30)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    retention_period = EXCLUDED.retention_period,
    rate_per_min = EXCLUDED.rate_per_min;

SELECT setval(pg_get_serial_sequence('rec_rate_card', 'id'), COALESCE((SELECT MAX(id) FROM rec_rate_card), 1));

-- 13. Customer Recording Rate Card Mapping
CREATE TABLE IF NOT EXISTS customer_rec_rc (
    cust_id TEXT PRIMARY KEY,
    rec_rc_id INTEGER NOT NULL REFERENCES rec_rate_card(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure cust_id is TEXT on existing or restored databases
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'customer_rec_rc' AND column_name = 'cust_id' AND data_type != 'text'
    ) THEN
        ALTER TABLE customer_rec_rc ALTER COLUMN cust_id TYPE TEXT USING cust_id::text;
    END IF;
END $$;

-- 14. Trigger for updated_at in rate_cards
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_rate_cards_updated_at ON rate_cards;
CREATE TRIGGER update_rate_cards_updated_at
    BEFORE UPDATE ON rate_cards
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();

-- 15. Call Detail Records (CDR)
CREATE TABLE IF NOT EXISTS cdr (
    cdr_id BIGSERIAL PRIMARY KEY,
    call_uuid UUID NOT NULL,
    customer_id TEXT NOT NULL,
    caller TEXT NOT NULL,
    callee TEXT NOT NULL,
    last_destination TEXT,
    direction TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    answer_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ NOT NULL,
    duration_sec INTEGER NOT NULL,
    billsec INTEGER NOT NULL,
    dest_type VARCHAR(50),
    dest_value VARCHAR(100),
    status_code VARCHAR(50),
    call_status VARCHAR(50),
    ingress_trunk TEXT,
    egress_trunk TEXT,
    route_id TEXT,
    gateway_id TEXT,
    currency CHAR(3) NOT NULL,
    ratecard_id BIGINT,
    billed_amount NUMERIC(12,6) NOT NULL DEFAULT 0,
    transaction_id BIGINT,
    is_rated BOOLEAN NOT NULL DEFAULT false,
    rated_at TIMESTAMPTZ,
    recording BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cdr_customer_id ON cdr(customer_id);
CREATE INDEX IF NOT EXISTS idx_cdr_start_time ON cdr(start_time);
CREATE INDEX IF NOT EXISTS idx_cdr_call_uuid ON cdr(call_uuid);

-- 16. Performance indexes
CREATE INDEX IF NOT EXISTS idx_subs_cust_status ON subscriptions(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_addons_status ON subscription_addons(subscription_id, status);
