const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');

const SCHEMA_FILE = path.join(__dirname, '../../schema.sql');
const DEFAULT_ADMIN = {
  name: 'Admin',
  email: 'admin@clicksurvey.com.au',
  password: 'AdminPass123!'
};

async function initDb() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;

  const setupConnection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true
  });
  await setupConnection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await setupConnection.end();

  const pool = await mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true
  });

  await ensureSchema(pool, database);
  await seedAdmin(pool);

  return pool;
}

async function ensureSchema(pool, database) {
  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?', [database]);
  if (rows[0].count === 0) {
    const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await pool.query(schemaSql);
  }
}

async function seedAdmin(pool) {
  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM users');
  if (rows[0].count === 0) {
    const password_hash = await bcrypt.hash(DEFAULT_ADMIN.password, 10);
    await pool.execute(
      'INSERT INTO users (name, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [DEFAULT_ADMIN.name, DEFAULT_ADMIN.email, password_hash]
    );
  }
}

module.exports = { initDb };
