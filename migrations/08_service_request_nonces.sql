CREATE TABLE IF NOT EXISTS service_request_nonces (nonce UUID PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_service_request_nonces_expiry ON service_request_nonces(expires_at);
