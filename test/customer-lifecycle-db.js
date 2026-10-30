require('dotenv').config();
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const assert = require('node:assert/strict');
const { createSubscriptionLifecycle } = require('../src/services/SubscriptionLifecycle');
const { createCustomerLifecycle } = require('../src/services/CustomerLifecycleService');
const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 10000 });
(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const wrapped = { query: (...args) => c.query(...args), connect: async () => ({ release() {}, query(sql, params) {
      return c.query(sql==='BEGIN' ? 'SAVEPOINT lifecycle_test' : sql==='COMMIT' ? 'RELEASE SAVEPOINT lifecycle_test' : sql==='ROLLBACK' ? 'ROLLBACK TO SAVEPOINT lifecycle_test' : sql, params);
    } }) };
    const subscriptions = createSubscriptionLifecycle(wrapped);
    const customers = createCustomerLifecycle(wrapped);
    const id = `TEST-${randomUUID()}`, plan = `PLAN-${randomUUID()}`, email = `${randomUUID()}@example.invalid`;
    await c.query("INSERT INTO customers(customer_id,fr_cusid,customer_type,admin_email,currency) VALUES($1,$1,'company',$2,'usd')", [id,email]);
    await c.query("INSERT INTO customer_wallets(customer_id,currency,fiat_balance) VALUES($1,'usd',1000)", [id]);
    await c.query("INSERT INTO plans(plan_id,name,amount,currency,validity_months,numbers,extensions,monitoring_extensions) VALUES($1,'Rollback archive',10,'usd',1,2,5,1)", [plan]);
    const subscription = await subscriptions.activate({ customer_id:id, plan_id:plan, operation_key:randomUUID(), auto_renew:true },'test');
    const did = randomUUID();
    await c.query("INSERT INTO did_assets(id,customer_id,subscription_id,source_type,did_number,status) VALUES($1,$2,$3,'plan','+15559990001','active')", [did,id,subscription.id]);
    await subscriptions.assignMonitoring({subscription_id:subscription.id,user_id:`USER-${id}`,name:'Rollback monitor',email,extension:'TEST01'},'test');
    const before = (await c.query('SELECT fiat_balance,credit_used FROM customer_wallets WHERE customer_id=$1',[id])).rows[0];
    const invoices = (await c.query('SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1',[id])).rows[0].n;
    const ledger = (await c.query('SELECT count(*)::int AS n FROM wallet_transactions WHERE customer_id=$1',[id])).rows[0].n;
    assert.equal((await customers.archive(id,'test')).lifecycle_status,'ARCHIVED');
    await customers.archive(id,'test');
    assert.equal((await c.query("SELECT count(*)::int AS n FROM customer_lifecycle_history WHERE customer_id=$1 AND event='ARCHIVED'",[id])).rows[0].n,1);
    assert.deepEqual((await c.query('SELECT fiat_balance,credit_used FROM customer_wallets WHERE customer_id=$1',[id])).rows[0],before);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1',[id])).rows[0].n,invoices);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM wallet_transactions WHERE customer_id=$1',[id])).rows[0].n,ledger);
    const closed = await subscriptions.subscription(subscription.id);
    assert.equal(closed.status,'cancelled'); assert.equal(closed.auto_renew,false);
    assert((await subscriptions.assets(subscription.id)).every(a => a.status==='frozen'));
    await assert.rejects(subscriptions.renew(subscription.id,randomUUID(),'test'),/Archived/);
    await assert.rejects(subscriptions.activate({customer_id:id,plan_id:plan,operation_key:randomUUID()},'test'),/archived/);
    await c.query("INSERT INTO customers(customer_id,fr_cusid,customer_type,admin_email,currency) VALUES($1,$1,'company',$2,'usd')",[`OTHER-${id}`,email]);
    await customers.releaseNumbers(id,'test','Provider-approved rollback test');
    assert.equal((await c.query('SELECT status FROM did_assets WHERE id=$1',[did])).rows[0].status,'released');
    assert.equal((await c.query('SELECT status FROM extension_assets WHERE subscription_id=$1 LIMIT 1',[subscription.id])).rows[0].status,'frozen');
    console.log('PASS: archive retry, cancelled renewal, held assets, preserved wallet/invoices/ledger, email reuse, scoped explicit number release. All fixtures rolled back.');
  } finally { await c.query('ROLLBACK'); c.release(); await pool.end(); }
})().catch(error => { console.error(error.stack); process.exitCode=1; });
