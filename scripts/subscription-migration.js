// Read configuration without logging credentials. Use --apply only against the intended development database.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const billing = dotenv.parse(fs.readFileSync(path.join(__dirname, '../.env')));
const pbx = dotenv.parse(fs.readFileSync(path.join(__dirname, '../../pbx-retail/backend/.env')));
const billingPool = new Pool({ host: billing.DB_HOST, port: Number(billing.DB_PORT || 5432), database: billing.DB_NAME,
  user: billing.DB_USER, password: billing.DB_PASSWORD, connectionTimeoutMillis: 15000 });
const pbxPool = new Pool({ connectionString: pbx.DATABASE_URL, connectionTimeoutMillis: 15000 });
(async () => {
  try {
    const migrated = await billingPool.query("SELECT 1 FROM information_schema.columns WHERE table_name='subscriptions' AND column_name='subscription_type'");
    const duplicates = await billingPool.query(`SELECT customer_id,COUNT(*)::int AS count FROM subscriptions WHERE status::text='active' ${migrated.rows.length ? "AND subscription_type='base'" : ''} GROUP BY customer_id HAVING COUNT(*)>1`);
    if (duplicates.rows.length) throw new Error(`Resolve duplicate active base subscriptions before migration: ${JSON.stringify(duplicates.rows)}`);
    if (!process.argv.includes('--apply')) {
      const counts = await billingPool.query('SELECT (SELECT COUNT(*) FROM subscriptions)::int AS subscriptions,(SELECT COUNT(*) FROM monitoring_assets)::int AS monitoring_assets');
      console.log('Billing preflight:', counts.rows[0]);
      const local = await pbxPool.query('SELECT COUNT(*)::int AS monitoring_users FROM users WHERE "monitoringEnabled"=true');
      console.log('PBX preflight:', local.rows[0]); return;
    }
    const c = await billingPool.connect();
    try { await c.query('BEGIN'); await c.query(fs.readFileSync(path.join(__dirname, '../migrations/05_subscription_lifecycle.sql'), 'utf8')); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await pbxPool.query(fs.readFileSync(path.join(__dirname, '../../pbx-retail/backend/prisma/subscription_lifecycle.sql'), 'utf8'));
    console.log('Subscription lifecycle migrations applied to billing and PBX. No wallet charges or routing changes were made.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await billingPool.end(); await pbxPool.end(); }
})();
