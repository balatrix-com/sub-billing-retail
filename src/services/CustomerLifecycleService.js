const { ASSETS } = require('./SubscriptionLifecycle');

function createCustomerLifecycle(pool) {
  async function transaction(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function archive(customerId, actor = 'system') {
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscriptions:${customerId}`]);
      const customer = (await client.query('SELECT * FROM customers WHERE customer_id=$1 FOR UPDATE', [customerId])).rows[0];
      if (!customer) throw Object.assign(new Error('Customer not found'), { statusCode: 404 });
      if (customer.lifecycle_status === 'ARCHIVED') return customer;
      const result = await client.query("UPDATE customers SET lifecycle_status='ARCHIVED',archived_at=now(),archive_reason='Tenant archive',updated_at=now() WHERE customer_id=$1 RETURNING *", [customerId]);
      const subscriptions = (await client.query('SELECT * FROM subscriptions WHERE customer_id=$1 ORDER BY id FOR UPDATE', [customerId])).rows;
      for (const s of subscriptions) {
        await client.query("UPDATE subscriptions SET status='cancelled',auto_renew=false,frozen_at=COALESCE(frozen_at,now()),updated_at=now() WHERE id=$1", [s.id]);
        await client.query("INSERT INTO subscription_history(subscription_id,event,actor_id,metadata) VALUES($1,'customer_archived',$2,$3)", [s.id, actor, { customer_id: customerId }]);
        await client.query("INSERT INTO subscription_outbox(subscription_id,action,payload) VALUES($1,'freeze',$2)", [s.id, { customer_id: customerId, subscription_id: s.id, actor_id: actor, reason: 'customer_archive' }]);
      }
      for (const asset of Object.values(ASSETS)) await client.query(`UPDATE ${asset.table} SET status='frozen',updated_at=now() WHERE customer_id=$1 AND status NOT IN ('released','unassigned')`, [customerId]);
      await client.query("INSERT INTO customer_lifecycle_history(customer_id,event,actor_id) VALUES($1,'ARCHIVED',$2)", [customerId, actor]);
      return result.rows[0];
    });
  }
  async function releaseNumbers(customerId, actor, reason) {
    return transaction(async client => {
      const customer = (await client.query('SELECT lifecycle_status FROM customers WHERE customer_id=$1 FOR UPDATE', [customerId])).rows[0];
      if (customer?.lifecycle_status !== 'ARCHIVED') throw Object.assign(new Error('Customer must be archived before number release'), { statusCode: 409 });
      for (const table of ['did_assets', 'tfn_assets']) await client.query(`UPDATE ${table} SET status='released',updated_at=now() WHERE customer_id=$1 AND status NOT IN ('released','unassigned')`, [customerId]);
      await client.query("INSERT INTO customer_lifecycle_history(customer_id,event,actor_id,metadata) VALUES($1,'NUMBERS_RELEASED',$2,$3)", [customerId, actor, { reason }]);
      return { customer_id: customerId, released: true };
    });
  }
  return { archive, releaseNumbers };
}
module.exports = { createCustomerLifecycle };
