const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '20000', 10),
});

const readonlyPool = new Pool({
  host: process.env.READONLY_DB_HOST,
  port: process.env.READONLY_DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.READONLY_DB_USER,
  password: process.env.READONLY_DB_PASSWORD,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '20000', 10),
});

pool.on('error', (err) => {
  console.error('Unexpected error on primary idle client', err);
});

readonlyPool.on('error', (err) => {
  console.error('Unexpected error on readonly idle client', err);
});

// Export both for new usage, while keeping pool as default for backward compatibility
pool.pool = pool;
pool.readonlyPool = readonlyPool;

module.exports = pool;
