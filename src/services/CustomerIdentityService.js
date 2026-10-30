const { signedHeaders } = require('../middleware/serviceAuth');

async function request(path, body) {
  const token = process.env.SUBSCRIPTION_SERVICE_TOKEN;
  if (!token) throw new Error('Customer identity service token is not configured');
  let base = (process.env.PBX_API_URL || 'http://localhost:3000').replace(/\/$/, '');
  if (!base.endsWith('/api')) base += '/api';
  const url = `${base}/internal/customer-identities/${path}`;
  const payload = JSON.stringify(body || {});
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-subscription-token': token,
      ...signedHeaders('POST', url, payload) },
    body: payload, signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Customer identity allocation failed');
  return result;
}
module.exports = {
  reserve: async prefix => (await request('reserve', { prefix })).customer_code,
  claim: async code => request(`${encodeURIComponent(code)}/claim`),
};
