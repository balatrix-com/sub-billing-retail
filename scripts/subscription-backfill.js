const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { createSubscriptionLifecycle } = require('../src/services/SubscriptionLifecycle');
const b = dotenv.parse(fs.readFileSync(path.join(__dirname,'../.env')));
const p = dotenv.parse(fs.readFileSync(path.join(__dirname,'../../pbx-retail/backend/.env')));
const billing = new Pool({host:b.DB_HOST,port:b.DB_PORT,database:b.DB_NAME,user:b.DB_USER,password:b.DB_PASSWORD,connectionTimeoutMillis:15000});
const pbx = new Pool({connectionString:p.DATABASE_URL,connectionTimeoutMillis:15000});
const lifecycle = createSubscriptionLifecycle(billing);
(async()=>{
  try {
    const tenants = (await pbx.query('SELECT id,"customerCode","subBillingCustomerId" FROM tenants')).rows;
    for (const t of tenants) {
      const customer = t.subBillingCustomerId || t.customerCode;
      if (!customer) continue;
      let subs = await lifecycle.list(customer);
      const users = (await pbx.query('SELECT id,name,email,"monitoringExtension" FROM users WHERE "tenantId"=$1 AND "monitoringEnabled"=true',[t.id])).rows;
      console.log(customer, 'subscriptions:',subs.length,'enabled monitoring users:',users.length);
      for(const u of users){
        let owner = subs.find(s=>s.assets.some(a=>a.type==='monitoring' && a.value===u.id && a.status==='active'));
        if (!owner) owner = subs.find(s=>['active','grace'].includes(s.status) && Number(s.usage.monitoring_extensions)<Number(s.entitlement_snapshot.monitoring_extensions));
        if (!owner) { console.error(customer,'unowned monitoring seat; active subscription capacity required');process.exitCode=1;continue; }
        if (!process.argv.includes('--apply')) continue;
        await lifecycle.assignMonitoring({subscription_id:owner.id,user_id:u.id,name:u.name,email:u.email,extension:u.monitoringExtension},'migration');
        await pbx.query(`INSERT INTO monitoring_seat_assignments(user_id,tenant_id,sub_billing_subscription_id,extension,status)
          VALUES($1,$2,$3,$4,'active') ON CONFLICT(user_id) DO UPDATE SET sub_billing_subscription_id=EXCLUDED.sub_billing_subscription_id,extension=EXCLUDED.extension,status='active'`,[u.id,t.id,owner.id,u.monitoringExtension]);
        const row = (await billing.query('SELECT id FROM monitoring_assets WHERE user_id=$1',[u.id])).rows[0];
        await pbx.query(`INSERT INTO subscription_asset_assignments(billing_asset_id,tenant_id,subscription_id,asset_type,resource_id,status)
          VALUES($1,$2,$3,'monitoring',$4,'active') ON CONFLICT(billing_asset_id) DO NOTHING`,[row.id,t.id,owner.id,u.id]);
        subs=await lifecycle.list(customer);
      }
      for(const s of subs) for(const a of s.assets) {
        const type=a.type;
        if(type==='monitoring' || !['did','tfn','extension'].includes(type)) continue;
        const table = {did:'dids',tfn:'tfns',extension:'extensions'}[type];
        const column = type==='extension' ? '"extensionNumber"' : 'number';
        const local = (await pbx.query(`SELECT id FROM ${table} WHERE "tenantId"=$1 AND ${column}=$2`,[t.id,a.value])).rows[0];
        if(local && process.argv.includes('--apply')) await pbx.query(`INSERT INTO subscription_asset_assignments(billing_asset_id,tenant_id,subscription_id,asset_type,resource_id,status)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(billing_asset_id) DO NOTHING`,[a.id,t.id,s.id,type,local.id,a.status]);
      }
      for(const [type,table,column] of [['did','dids','number'],['tfn','tfns','number'],['extension','extensions','"extensionNumber"']]) {
        const local = (await pbx.query(`SELECT ${column} AS value FROM ${table} WHERE "tenantId"=$1`,[t.id])).rows;
        for(const a of local) if(!subs.some(s=>s.assets.some(x=>x.type===type && x.value===a.value && x.status!=='released'))) {
          console.error(customer,`unowned ${type} ${a.value}; resolve before enabling the automatic worker`);process.exitCode=1;
        }
      }
    }
    console.log('Backfill does not modify SIP credentials, routing, user flags, or wallet balances.');
  }catch(e){console.error(e.message);process.exitCode=1;}
  finally{await billing.end();await pbx.end();}
})();
