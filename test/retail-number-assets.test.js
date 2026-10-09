const test = require('node:test');
const assert = require('node:assert/strict');
const { createRetailNumberAssets } = require('../src/services/RetailNumberAssets');

function fixture({ used = 0, limit = 2, existing = null, unassignRowCount = 1 } = {}) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      queries.push({ statement, params });
      if (statement.includes('FROM subscriptions s JOIN plans p')) {
        return { rows: [{ id: 'sub-1', subscription_id: 'SUB-1', customer_id: 'U1001', plan_id: 'basic', numbers: limit }] };
      }
      if (statement.includes('AS used')) return { rows: [{ used }] };
      if (statement.includes('FROM tfn_assets a JOIN subscriptions s ON s.id = a.subscription_id')) {
        return { rows: existing ? [existing] : [] };
      }
      if (statement.startsWith('UPDATE did_assets') || statement.startsWith('UPDATE tfn_assets')) {
        return { rows: [], rowCount: unassignRowCount };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  const assets = createRetailNumberAssets({ async connect() { return client; } });
  return { assets, queries, get released() { return released; } };
}

test('rejects a TFN already owned by another customer without reassignment', async () => {
  const state = fixture({ existing: { id: 'other', subscription_id: 'sub-other', customer_id: 'U2002', status: 'active', subscription_status: 'active' } });
  await assert.rejects(state.assets.syncAssets('SUB-1', { tfns: ['+18005550123'] }), error => error.statusCode === 409);
  assert.equal(state.queries.some(query => query.statement.startsWith('UPDATE tfn_assets')), false);
  assert.equal(state.queries.at(-1).statement, 'ROLLBACK');
  assert.equal(state.released, true);
});

test('enforces the pooled plan cap before inserting a DID', async () => {
  const state = fixture({ used: 2, limit: 2 });
  await assert.rejects(state.assets.syncAssets('SUB-1', { dids: ['+15551234567'] }), error => error.statusCode === 409);
  assert.equal(state.queries.some(query => query.statement.startsWith('INSERT INTO did_assets')), false);
});

test('inserts a real number and returns updated pooled usage', async () => {
  const state = fixture({ used: 1, limit: 2 });
  const result = await state.assets.syncAssets('SUB-1', { tfns: ['+18005550123'] });
  assert.deepEqual(result, { success: true, used: 2, limit: 2 });
  assert.equal(state.queries.some(query => query.statement.startsWith('INSERT INTO tfn_assets')), true);
  assert.equal(state.queries.at(-1).statement, 'COMMIT');
});

test('unassignment is scoped to the selected subscription', async () => {
  const state = fixture();
  await state.assets.unassignAssets('SUB-1', { dids: ['+15551234567'] });
  const update = state.queries.find(query => query.statement.startsWith('UPDATE did_assets'));
  assert.match(update.statement, /WHERE subscription_id = \$1 AND did_number = \$2/);
  assert.deepEqual(update.params, ['sub-1', '+15551234567']);
});

test('refuses an unassignment that has no matching sub-billing asset', async () => {
  const state = fixture({ unassignRowCount: 0 });
  await assert.rejects(state.assets.unassignAssets('SUB-1', { dids: ['+15551234567'] }),
    error => error.statusCode === 409);
  assert.equal(state.queries.at(-1).statement, 'ROLLBACK');
});

test('rejects a number entered as both types', async () => {
  const state = fixture();
  await assert.rejects(state.assets.syncAssets('SUB-1', { dids: ['+15551234567'], tfns: ['+15551234567'] }),
    error => error.statusCode === 400);
  assert.equal(state.queries.length, 0);
});
