// Read-only smoke test: actual PBX service -> authenticated billing HTTP route -> development PostgreSQL.
const fs=require('fs'),path=require('path'),dotenv=require('dotenv'),assert=require('node:assert/strict');
const b=dotenv.parse(fs.readFileSync(path.join(__dirname,'../.env')));
Object.assign(process.env,b);
const p=dotenv.parse(fs.readFileSync(path.join(__dirname,'../../pbx-retail/backend/.env')));
const express=require('express');
const app=express();app.use(express.json());app.use('/api/subscription-management',require('../src/routes/subscriptionManagementRoutes'));
const pool=require('../src/config/database');
const pbxRoot=path.join(__dirname,'../../pbx-retail/backend');
const {PrismaClient}=require(path.join(pbxRoot,'node_modules/@prisma/client'));
const {HttpService}=require(path.join(pbxRoot,'node_modules/@nestjs/axios'));
const {SubscriptionsService}=require(path.join(pbxRoot,'dist/src/subscriptions/subscriptions.service'));
const prisma=new PrismaClient({datasources:{db:{url:p.DATABASE_URL}}});
const server=app.listen(0,'127.0.0.1',async()=>{
  try{
    const port=server.address().port;
    const config={get:key=>key==='SUB_BILLING_API_URL' ? `http://127.0.0.1:${port}/api` : p[key]};
    const service=new SubscriptionsService(prisma,new HttpService(),config,{}, {},{}, {},{});
    const tenant=await prisma.tenant.findFirst({where:{customerCode:'U1001'}});
    assert.ok(tenant,'Development tenant U1001 is required for this smoke test');
    const rows=await service.list(tenant.id);
    assert.ok(rows.some(s=>s.subscription_type==='base'));
    assert.ok(rows.some(s=>s.subscription_type==='capacity'));
    assert.ok(rows.some(s=>s.assets.some(a=>a.type==='monitoring' && a.status==='active')));
    const quote=await service.request('quote','POST',{plan_id:rows.find(s=>s.subscription_type==='base').plan_id,duration_unit:'days',duration_count:20});
    assert.ok(Number.isFinite(quote.initial_charge));
    await assert.rejects(service.owned(tenant.id,'foreign-subscription'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/subscription-management/customer/U1001`)).status,401);
    console.log('PASS: PBX reads both subscription types and real monitoring assets through authenticated billing HTTP, prices custom durations, rejects foreign subscriptions and unauthenticated access. No data changed.');
  }catch(e){console.error(e.stack);process.exitCode=1;}
  finally{server.close();await prisma.$disconnect();await pool.end();await pool.readonlyPool.end();}
});
