const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function runMigrations() {
  try {
    const migrationsDir = path.join(__dirname);
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Run them in alphanumeric order

    console.log(`Found ${files.length} migration files.`);

    for (const file of files) {
      console.log(`Running migration: ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      
      try {
        await pool.query(sql);
        console.log(`✓ Migration ${file} completed successfully.`);
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.log(`! Migration ${file} partially or fully already applied: ${err.message}`);
        } else {
          console.log(`! Migration ${file} error: ${err.message}`);
        }
      }
    }

    console.log('All migrations processed.');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

runMigrations();
