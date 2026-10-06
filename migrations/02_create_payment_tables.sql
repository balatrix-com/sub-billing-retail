-- =============================================
-- 02: Payment Tables
-- Fully Idempotent & Production Ready
-- =============================================

-- 1. Main payments table
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id VARCHAR(50) UNIQUE NOT NULL,           -- PAY-2601-001 (human-readable)
  transaction_id VARCHAR(255) UNIQUE,
  customer_id VARCHAR(50) NOT NULL,
  
  -- Amount details
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  
  -- Payment status
  status VARCHAR(20) NOT NULL DEFAULT 'pending',    -- pending, processing, completed, failed, cancelled, expired
  payment_method VARCHAR(50),                       -- stripe, paypal, bank_transfer
  gateway VARCHAR(50),
  
  -- Stripe session details
  stripe_session_id VARCHAR(255),                   -- cs_test_abc123
  stripe_payment_intent_id VARCHAR(255),            -- pi_xyz789
  stripe_charge_id VARCHAR(255),                    -- ch_123
  
  -- Redirect URLs used
  success_url TEXT,
  cancel_url TEXT,
  
  -- Metadata
  description TEXT,
  metadata JSONB,                                   -- Store any extra info
  
  -- Linking
  billing_cycle_id UUID,                            -- Link to subscription billing cycle (if auto-renewal)
  subscription_id UUID,                             -- Link to subscription (if plan purchase)
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,                           -- Session expires in 24 hours
  completed_at TIMESTAMPTZ,                         -- When payment actually completed
  
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_session ON payments(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_intent ON payments(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);


-- 2. Payment transactions (audit trail for each step)
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  
  customer_id VARCHAR(50) NOT NULL,
  transaction_type VARCHAR(50) NOT NULL,            -- session_created, webhook_received, wallet_credited, refund_issued
  amount DECIMAL(10,2),
  
  status VARCHAR(20) NOT NULL,                      -- success, failed, pending
  gateway_response JSONB,                           -- Full Stripe API response
  error_message TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_txns_payment ON payment_transactions(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_txns_customer ON payment_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_txns_type ON payment_transactions(transaction_type);


-- 3. Webhook events (audit all webhooks received from Stripe)
CREATE TABLE IF NOT EXISTS payment_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  webhook_id VARCHAR(100) UNIQUE,                   -- Stripe webhook event ID (evt_123)
  payment_id UUID REFERENCES payments(id),          -- Link to payment (if found)
  
  event_type VARCHAR(100) NOT NULL,                 -- checkout.session.completed, payment_intent.succeeded
  stripe_signature VARCHAR(500),                    -- Signature for verification
  
  payload JSONB NOT NULL,                           -- Full webhook body
  status VARCHAR(20) NOT NULL DEFAULT 'received',   -- received, processed, failed, ignored
  
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_payment ON payment_webhooks(payment_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_event_type ON payment_webhooks(event_type);
CREATE INDEX IF NOT EXISTS idx_webhooks_status ON payment_webhooks(status);
CREATE INDEX IF NOT EXISTS idx_webhooks_created ON payment_webhooks(created_at DESC);


-- 4. Payment refunds (future use)
CREATE TABLE IF NOT EXISTS payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id VARCHAR(50) UNIQUE NOT NULL,            -- REF-2601-001
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  
  customer_id VARCHAR(50) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  reason VARCHAR(100),
  
  stripe_refund_id VARCHAR(255),                    -- re_123
  status VARCHAR(20) NOT NULL DEFAULT 'pending',    -- pending, completed, failed
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment ON payment_refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_customer ON payment_refunds(customer_id);


-- 5. Customer payment methods (future use - stored cards)
CREATE TABLE IF NOT EXISTS customer_payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id VARCHAR(50) NOT NULL,
  
  stripe_payment_method_id VARCHAR(255) UNIQUE,     -- pm_123
  type VARCHAR(20),                                  -- card, bank_account
  
  -- Card details (last 4 digits only, rest stored by Stripe)
  card_brand VARCHAR(20),                            -- visa, mastercard
  card_last4 VARCHAR(4),
  card_exp_month INT,
  card_exp_year INT,
  
  is_default BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'active',               -- active, expired, removed
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_customer ON customer_payment_methods(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_default ON customer_payment_methods(customer_id, is_default);
