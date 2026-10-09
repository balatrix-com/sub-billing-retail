const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const Plan = require('../src/models/Plan');
const { periodEnd } = require('../src/services/SubscriptionLifecycle');

test('plan persistence preserves day/month durations and resource limits', async () => {
  const originalQuery = pool.query;
  try {
    for (const [count, unit, months, end] of [
      [15, 'days', 1, '2026-10-24T00:00:00.000Z'],
      [1, 'months', 1, '2026-11-09T00:00:00.000Z'],
      [6, 'months', 6, '2027-04-09T00:00:00.000Z'],
    ]) {
      pool.query = async (sql, values) => {
        assert.match(sql, /INSERT INTO plans/);
        assert.equal(values[4], months);
        assert.equal(values[7], 5);
        assert.equal(values[8], 2);
        assert.equal(values[13], unit);
        assert.equal(values[14], count);
        return { rows: [{ duration_unit: values[13], duration_count: values[14] }] };
      };
      const saved = await Plan.create({
        plan_id: 'duration_test', name: 'Duration test', amount: 10, currency: 'usd',
        validity_months: months, duration_count: count, duration_unit: unit,
        extensions: 5, monitoring_extensions: 2,
      });
      assert.equal(periodEnd('2026-10-09T00:00:00Z', saved.duration_unit, saved.duration_count).toISOString(), end);
    }
  } finally {
    pool.query = originalQuery;
    await pool.end();
  }
});
