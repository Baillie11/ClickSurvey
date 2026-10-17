require("dotenv").config();
const bcrypt = require("bcrypt");
const { initDb } = require("../src/models/db");
const { text, email } = require("../src/validation");
(async () => {
  const address = email(process.env.ADMIN_EMAIL);
  const name = text(process.env.ADMIN_NAME || "Administrator", "admin name");
  const password = process.env.ADMIN_PASSWORD;
  if (
    !password ||
    password.length < 16 ||
    Buffer.byteLength(password) > 72 ||
    password === "AdminPass123!"
  )
    throw new Error("Set ADMIN_PASSWORD to a unique 16–72 byte password");
  const db = await initDb();
  try {
    await db.execute(
      "INSERT INTO users (name,email,password_hash,is_admin,created_at,updated_at) VALUES (?,?,?,1,UTC_TIMESTAMP(),UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE name=VALUES(name),password_hash=VALUES(password_hash),is_admin=1,updated_at=UTC_TIMESTAMP()",
      [name, address, await bcrypt.hash(password, 12)],
    );
    console.log("Administrator provisioned");
  } finally {
    await db.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
