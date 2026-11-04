const test = require('node:test');
const assert = require('node:assert/strict');
const { periodEnd, serviceAuth, createSubscriptionLifecycle } = require('../src/services/SubscriptionLifecycle');

test('calendar month renewal clips January 31 and leap years correctly', () => {
  assert.equal(periodEnd('2026-01-31T12:00:00Z','months',1).toISOString(),'2026-02-28T12:00:00.000Z');
  assert.equal(periodEnd('2024-01-31T12:00:00Z','months',1).toISOString(),'2024-02-29T12:00:00.000Z');
});

test('twenty-day duration is exact, not a rounded month', () => {
  assert.equal(periodEnd('2026-10-09T00:00:00Z','days',20).toISOString(),'2026-10-29T00:00:00.000Z');
});

test('invalid durations are rejected', () => {
  for (const [u,c] of [['weeks',1],['days',0],['months',1.5],['days',3661]]) assert.throws(() => periodEnd(new Date(),u,c));
});

test('internal authentication fails closed and handles unicode safely', () => {
  const old = process.env.SUBSCRIPTION_SERVICE_TOKEN;
  process.env.SUBSCRIPTION_SERVICE_TOKEN = 'abc';
  let denied = 0, accepted = 0;
  const res = { status(n) { assert.equal(n,401); denied++; return this; }, json() {} };
  serviceAuth({ headers: { 'x-subscription-token':'ééé' } },res,() => accepted++);
  serviceAuth({ headers: { 'x-subscription-token':'abc' } },res,() => accepted++);
  assert.equal(denied,1); assert.equal(accepted,1);
  if (old === undefined) delete process.env.SUBSCRIPTION_SERVICE_TOKEN; else process.env.SUBSCRIPTION_SERVICE_TOKEN = old;
});

test('SubscriptionLifecycle exposes listAll along with list', () => {
  const dummyPool = { query: async () => ({ rows: [] }) };
  const lifecycle = createSubscriptionLifecycle(dummyPool);
  assert.equal(typeof lifecycle.listAll, 'function');
  assert.equal(typeof lifecycle.list, 'function');
});
