const crypto = require('crypto');
const pool = require('../config/database');

const MAX_AGE_MS = 5 * 60 * 1000;

function getSecret() {
  const secret = process.env.PBX_SUB_BILLING_SERVICE_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Service authentication is not configured');
  return secret;
}

function sign(method, path, timestamp, nonce, body, customerId = '', idempotencyKey = '') {
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', getSecret())
    .update(`${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${digest}\n${customerId}\n${idempotencyKey}`)
    .digest('hex');
}

function signedHeaders(method, url, body = '') {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const parsed = new URL(url);
  return {
    'x-pbx-service-time': timestamp,
    'x-pbx-service-nonce': nonce,
    'x-pbx-service-signature': sign(method, parsed.pathname + parsed.search, timestamp, nonce, Buffer.from(body))
  };
}

async function requireService(req, res, next) {
  try {
    const timestamp = req.get('x-pbx-service-time');
    const nonce = req.get('x-pbx-service-nonce');
    const received = req.get('x-pbx-service-signature');
    if (!/^\d{13}$/.test(timestamp || '') || Math.abs(Date.now() - Number(timestamp)) > MAX_AGE_MS ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce || '') ||
        !/^[0-9a-f]{64}$/i.test(received || '')) {
      return res.status(401).json({ message: 'Invalid service request' });
    }
    const customerId = req.get('x-pbx-customer-id') || '';
    const idempotencyKey = req.get('idempotency-key') || '';
    const expected = sign(req.method, req.originalUrl, timestamp, nonce, req.rawBody || Buffer.alloc(0), customerId, idempotencyKey);
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))) {
      return res.status(401).json({ message: 'Invalid service request' });
    }
    // The unique nonce is shared by all workers; fail closed when the database is unavailable.
    const inserted = await pool.query(
      'INSERT INTO service_request_nonces (nonce, expires_at) VALUES ($1, now() + interval \'10 minutes\') ON CONFLICT DO NOTHING RETURNING nonce',
      [nonce]
    );
    if (inserted.rowCount !== 1) return res.status(401).json({ message: 'Replayed service request' });
    req.principal = { kind: 'pbx-service', id: 'pbx-backend', customerId: customerId || null };
    next();
  } catch (error) {
    console.error('[serviceAuth] Authentication unavailable:', error.message);
    res.status(503).json({ message: 'Service authentication unavailable' });
  }
}

module.exports = { requireService, signedHeaders };
