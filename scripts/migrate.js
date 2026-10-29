require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { dbOptions } = require("../src/models/db");
async function migrate(connection) {
  const [[lock]] = await connection.query(
    "SELECT GET_LOCK(CONCAT(DATABASE(), ':migrate'), 30) AS acquired",
  );
  if (!lock.acquired) throw new Error("Migration lock unavailable");
  try {
    await connection.query(
      fs.readFileSync(path.join(__dirname, "../schema.sql"), "utf8"),
    );
    // Older migrations inherited the host's default engine for these internal
    // tables. Upgrade only these known tables; retain the guard for application data.
    const [internalTables] = await connection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' AND engine <> 'InnoDB' AND table_name IN ('schema_migrations','sessions','worker_state')",
    );
    for (const { table_name } of internalTables) {
      if (["schema_migrations", "sessions", "worker_state"].includes(table_name))
        await connection.query(`ALTER TABLE ${table_name} ENGINE=InnoDB`);
    }
    const [engines] = await connection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' AND engine <> 'InnoDB'",
    );
    if (engines.length)
      throw new Error(
        "Convert existing tables to InnoDB before migration; transactional writes require InnoDB",
      );
    await connection.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) PRIMARY KEY, applied_at DATETIME NOT NULL) ENGINE=InnoDB",
    );
    await connection.query(
      "CREATE TABLE IF NOT EXISTS sessions (session_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, data MEDIUMTEXT NOT NULL, expires_at DATETIME NOT NULL, INDEX idx_session_expiry (expires_at)) ENGINE=InnoDB",
    );
    await connection.query(
      "CREATE TABLE IF NOT EXISTS worker_state (id INT PRIMARY KEY, heartbeat_at DATETIME NOT NULL) ENGINE=InnoDB",
    );
    const [done] = await connection.query(
      "SELECT version FROM schema_migrations WHERE version = '001-hardening'",
    );

    async function column(table, name, definition) {
      const [rows] = await connection.execute(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        [table, name],
      );
      if (!rows.length)
        await connection.query(
          `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
        );
    }
    async function index(table, name, definition) {
      const [rows] = await connection.execute(
        "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
        [table, name],
      );
      if (!rows.length)
        await connection.query(`ALTER TABLE ${table} ADD ${definition}`);
    }
    const [emailDone] = await connection.query(
      "SELECT version FROM schema_migrations WHERE version = '002-survey-email'",
    );
    if (!emailDone.length) {
      await column("surveys", "email_subject", "VARCHAR(255) NULL");
      await column("surveys", "email_sender_name", "VARCHAR(255) NULL");
      await connection.query(
        "INSERT INTO schema_migrations VALUES ('002-survey-email', UTC_TIMESTAMP())",
      );
    }
    const [logicDone] = await connection.query(
      "SELECT version FROM schema_migrations WHERE version = '003-question-logic'",
    );
    if (!logicDone.length) {
      await column("survey_questions", "condition_question_id", "INT NULL");
      await column("survey_questions", "condition_value", "VARCHAR(255) NULL");
      await connection.query(
        "INSERT INTO schema_migrations VALUES ('003-question-logic', UTC_TIMESTAMP())",
      );
    }
    const [historyDone] = await connection.query("SELECT version FROM schema_migrations WHERE version = '004-invitation-history'");
    if (!historyDone.length) {
      await column('survey_invites', 'email_opened_at', 'DATETIME NULL');
      await column('survey_invites', 'email_tracking_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
      await connection.query("INSERT INTO schema_migrations VALUES ('004-invitation-history', UTC_TIMESTAMP())");
    }
    if (done.length) return;
    await column("users", "is_admin", "TINYINT(1) NOT NULL DEFAULT 0");
    await column("api_clients", "key_id", "VARCHAR(32) NULL");
    await index("api_clients", "uq_key_id", "UNIQUE INDEX uq_key_id (key_id)");
    await column(
      "events",
      "event_key",
      "VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL",
    );
    await column("events", "payload_hash", "CHAR(64) NULL");
    await column("events", "invite_id", "INT NULL");
    await index(
      "events",
      "uq_client_event",
      "UNIQUE INDEX uq_client_event (api_client_id, event_key)",
    );
    await column("survey_invites", "due_at", "DATETIME NULL");
    await column("survey_invites", "expires_at", "DATETIME NULL");
    await column("survey_invites", "attempts", "INT NOT NULL DEFAULT 0");
    await column("survey_invites", "last_error", "VARCHAR(255) NULL");
    await column(
      "survey_questions",
      "archived",
      "TINYINT(1) NOT NULL DEFAULT 0",
    );
    await index(
      "survey_invites",
      "idx_delivery",
      "INDEX idx_delivery (status, due_at)",
    );
    await index(
      "suppressions",
      "idx_suppression_email",
      "INDEX idx_suppression_email (email)",
    );
    // Keep historical duplicates while enforcing one completion for new responses.
    await column("survey_responses", "completion_key", "INT NULL");
    await index(
      "survey_responses",
      "uq_completion",
      "UNIQUE INDEX uq_completion (completion_key)",
    );
    await connection.query(
      "UPDATE survey_invites SET due_at = COALESCE(sent_at, created_at), expires_at = DATE_ADD(COALESCE(sent_at, created_at), INTERVAL 30 DAY) WHERE expires_at IS NULL",
    );
    await connection.query(
      "UPDATE api_clients SET status = 'Disabled' WHERE key_id IS NULL",
    );
    await connection.query(
      "INSERT INTO schema_migrations VALUES ('001-hardening', UTC_TIMESTAMP())",
    );
  } finally {
    await connection.query(
      "SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':migrate'))",
    );
  }
}
async function main() {
  const connection = await mysql.createConnection(
    dbOptions({ multipleStatements: true }),
  );
  try {
    await migrate(connection);
    console.log("Database migrations complete");
  } finally {
    await connection.end();
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { migrate };
