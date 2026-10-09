// Integration assertions run inside one outer transaction; all fixtures/debits are rolled back.
require('dotenv').config();
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const assert = require('node:assert/strict');
const { createSubscriptionLifecycle } = require('../src/services/SubscriptionLifecycle');
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 15000 });
(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const wrapped = { query: (...args) => c.query(...args), connect: async () => ({ release() {}, query(sql,params) {
      return c.query(sql === 'BEGIN' ? 'SAVEPOINT lifecycle_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT lifecycle_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT lifecycle_test' : sql,params);
    } }) };
    const lifecycle = createSubscriptionLifecycle(wrapped);
    const customer = `TEST-${randomUUID()}`, basePlan = `TEST-BASE-${randomUUID()}`, capacityPlan = `TEST-CAP-${randomUUID()}`;
    await c.query("INSERT INTO customers(customer_id,fr_cusid,customer_type,admin_email,currency) VALUES($1,$1,'company','test@example.invalid','usd')",[customer]);
    await c.query("INSERT INTO customer_wallets(customer_id,currency,fiat_balance) VALUES($1,'usd',1000)",[customer]);
    await c.query("INSERT INTO plans(plan_id,name,amount,currency,validity_months,numbers,monitoring_extensions,plan_category,duration_unit,duration_count,setup_fees) VALUES($1,'Test Base',10,'usd',1,1,1,'base','months',1,3),($2,'Test Capacity',5,'usd',1,2,1,'capacity','days',20,0)",[basePlan,capacityPlan]);
    const key = randomUUID();
    const base = await lifecycle.activate({ customer_id: customer,plan_id: basePlan,operation_key:key },'test');
    const again = await lifecycle.activate({ customer_id: customer,plan_id: basePlan,operation_key:key },'test');
    assert.equal(base.id,again.id);
    assert.equal(Number((await c.query('SELECT fiat_balance FROM customer_wallets WHERE customer_id=$1',[customer])).rows[0].fiat_balance),987);
    await assert.rejects(lifecycle.activate({customer_id:customer,plan_id:basePlan,operation_key:randomUUID()},'test'));
    const cap = await lifecycle.activate({customer_id:customer,plan_id:capacityPlan,operation_key:randomUUID()},'test');
    const asset = randomUUID();
    await c.query("INSERT INTO did_assets(id,customer_id,subscription_id,source_type,did_number,status) VALUES($1,$2,$3,'plan','+15559990000','active')",[asset,customer,cap.id]);
    await lifecycle.assignMonitoring({subscription_id:base.id,user_id:`USER-${customer}`,extension:'TEST01'},'test');
    await lifecycle.transition(cap.id,'freeze','test');
    assert.equal((await lifecycle.subscription(base.id)).status,'active');
    assert.equal((await lifecycle.assets(cap.id))[0].status,'frozen');
    await lifecycle.move({type:'did',asset_id:asset,target_subscription_id:base.id},'test');
    assert.equal((await lifecycle.assets(base.id)).find(a => a.id === asset).status,'active');
    const second = randomUUID();
    await c.query("INSERT INTO did_assets(id,customer_id,subscription_id,source_type,did_number,status) VALUES($1,$2,$3,'plan','+15559990001','frozen')",[second,customer,cap.id]);
    await assert.rejects(lifecycle.move({type:'did',asset_id:second,target_subscription_id:base.id},'test'));
    const renewalKey = randomUUID(); await lifecycle.renew(cap.id,renewalKey,'test'); await lifecycle.renew(cap.id,renewalKey,'test');
    assert.equal((await c.query('SELECT COUNT(*)::int AS count FROM wallet_transactions WHERE reference=$1',[renewalKey])).rows[0].count,1);
    await lifecycle.transferMonitoring({subscription_id:base.id,from_user_id:`USER-${customer}`,to_user_id:`OTHER-${customer}`,extension:'TEST01'},'test');
    assert.equal((await lifecycle.assets(base.id)).filter(a=>a.type==='monitoring' && a.status==='active').length,1);
    await c.query('UPDATE plans SET numbers=99 WHERE plan_id=$1',[basePlan]);
    assert.equal((await lifecycle.subscription(base.id)).entitlement_snapshot.numbers,1);
    await c.query('UPDATE plans SET setup_fees=2 WHERE plan_id=$1',[capacityPlan]);
    const pending=await lifecycle.activate({customer_id:customer,plan_id:capacityPlan,payment_mode:'pending',operation_key:randomUUID()},'test');
    assert.equal(pending.status,'pending_activation');assert.equal((await lifecycle.assets(pending.id)).length,0);
    const beforePending=Number((await c.query('SELECT fiat_balance FROM customer_wallets WHERE customer_id=$1',[customer])).rows[0].fiat_balance);
    await lifecycle.renew(pending.id,randomUUID(),'test');
    const afterPending=Number((await c.query('SELECT fiat_balance FROM customer_wallets WHERE customer_id=$1',[customer])).rows[0].fiat_balance);
    assert.equal(beforePending-afterPending,7);
    assert.equal((await c.query("SELECT COUNT(*)::int AS count FROM invoices WHERE subscription_id=$1 AND status='paid'",[pending.id])).rows[0].count,1);
    await c.query("UPDATE customer_wallets SET fiat_balance=0,credit_limit=0 WHERE customer_id=$1",[customer]);
    await c.query("UPDATE subscriptions SET end_date=now()-interval '1 day',auto_renew=true WHERE id=$1",[cap.id]);
    assert.equal((await lifecycle.renew(cap.id,'AUTO-TEST','worker',true)).status,'grace');
    await assert.rejects(lifecycle.transition(cap.id,'release','test'));
    console.log('PASS: activation idempotency, base uniqueness, multi-plan capacity, isolated freeze, frozen asset reassignment, quota rejection, renewal single debit, payment grace, release guard, monitoring transfer, immutable snapshots and pending setup invoice payment. All fixtures rolled back.');
  } catch(e) { console.error(e.stack); process.exitCode=1; }
  finally { await c.query('ROLLBACK'); c.release(); await pool.end(); }
})();
