const mysql = require("mysql2/promise");
function dbOptions(overrides = {}) {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: "Z",
    charset: "utf8mb4",
    connectionLimit: 10,
    ...overrides,
  };
}
async function initDb() {
  const pool = mysql.createPool(dbOptions());
  try {
    await pool.query("SELECT is_admin FROM users LIMIT 1");
    const [rows] = await pool.query(
      "SELECT version FROM schema_migrations WHERE version IN ('001-hardening', '002-survey-email', '003-question-logic', '004-invitation-history')",
    );
    if (rows.length !== 4) throw new Error("Run npm run db:migrate before starting");
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
async function transaction(pool, work) {
  for (let attempt = 0; ; attempt++) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (
        !["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code) ||
        attempt >= 5
      )
        throw error;
    } finally {
      connection.release();
    }
    // Only database work belongs in work(): retries must not repeat external effects.
    await new Promise((resolve) =>
      setTimeout(resolve, 20 * (attempt + 1) + Math.random() * 30),
    );
  }
}
module.exports = { initDb, dbOptions, transaction };
