const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function runMigrations() {
  const client = await pool.connect();
  try {
    const isStatusOnly = process.argv.includes('--status') || process.argv.includes('--check');

    // 1. Ensure migrations tracking table exists in bala_billing
    await client.query(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        execution_ms INTEGER
      );
    `);

    // 2. Fetch list of previously applied migrations
    const appliedResult = await client.query('SELECT name, applied_at, execution_ms FROM _schema_migrations ORDER BY id ASC;');
    const appliedMap = new Map(appliedResult.rows.map(r => [r.name, r]));

    // 3. Discover all migration files matching \d+_*.sql
    const migrationsDir = path.join(__dirname);
    const files = fs.readdirSync(migrationsDir)
      .filter(file => /^\d+_.*\.sql$/.test(file))
      .sort((a, b) => {
        const numA = parseInt(a.split('_')[0], 10);
        const numB = parseInt(b.split('_')[0], 10);
        return numA - numB;
      });

    const pendingFiles = files.filter(f => !appliedMap.has(f));
    const appliedCount = files.length - pendingFiles.length;

    console.log('================================================================');
    console.log('DATABASE MIGRATION RUNNER (Retail Sub-Billing)');
    console.log(`Target Database: ${process.env.DB_NAME || 'bala_billing'} @ ${process.env.DB_HOST || 'localhost'}`);
    console.log(`Total Migration Files Discovered: ${files.length}`);
    console.log(`Total Already Applied:            ${appliedCount}`);
    console.log(`Pending Migrations Left:          ${pendingFiles.length}`);
    console.log('================================================================');

    // If check / status only
    if (isStatusOnly) {
      console.log('\nMIGRATION STATUS:');
      files.forEach(f => {
        if (appliedMap.has(f)) {
          const info = appliedMap.get(f);
          const dateStr = info.applied_at ? new Date(info.applied_at).toISOString() : 'previously';
          console.log(`  [APPLIED]  ${f.padEnd(40)} (applied ${dateStr}, ${info.execution_ms || 0}ms)`);
        } else {
          console.log(`  [PENDING]  ${f.padEnd(40)} ⚠️ Needs migration`);
        }
      });

      console.log('----------------------------------------------------------------');
      if (pendingFiles.length === 0) {
        console.log('✓ All migrations are up to date. No pending migrations left.\n');
      } else {
        console.log(`⚠️ ${pendingFiles.length} migration(s) left which need to be migrated.\n`);
      }
      return;
    }

    // Normal run: check if migrations are left
    if (pendingFiles.length === 0) {
      console.log('\n✓ Database is up to date. No pending migrations left to apply.\n');
      return;
    }

    console.log(`\n⚠️ Found ${pendingFiles.length} migration(s) left that need to be migrated:`);
    pendingFiles.forEach((f, idx) => {
      console.log(`  ${idx + 1}. ${f}`);
    });
    console.log('\nStarting migration application...\n');

    let newlyAppliedCount = 0;

    for (const file of pendingFiles) {
      console.log(`[APPLYING] ${file}...`);
      const startTime = Date.now();
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        const duration = Date.now() - startTime;
        await client.query(
          'INSERT INTO _schema_migrations (name, execution_ms) VALUES ($1, $2);',
          [file, duration]
        );
        await client.query('COMMIT');
        console.log(`[SUCCESS]  ${file} (completed in ${duration}ms)`);
        newlyAppliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`\n[FAILED]   Migration ${file} failed with error:\n${err.message}`);
        console.error('Transaction was rolled back. Halting migrations.\n');
        throw err;
      }
    }

    console.log('================================================================');
    console.log(`✓ Migration run complete!`);
    console.log(`  Newly applied: ${newlyAppliedCount}`);
    console.log(`  Total up to date: ${files.length} / ${files.length}`);
    console.log('================================================================\n');
  } catch (err) {
    console.error('Migration process aborted:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
