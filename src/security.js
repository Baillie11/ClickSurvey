const crypto = require("crypto");
const session = require("express-session");
class MysqlSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
  }
  get(id, callback) {
    this.db
      .execute(
        "SELECT data FROM sessions WHERE session_id = ? AND expires_at > UTC_TIMESTAMP()",
        [id],
      )
      .then(([rows]) =>
        callback(null, rows[0] ? JSON.parse(rows[0].data) : null),
      )
      .catch(callback);
  }
  set(id, value, callback = () => {}) {
    const expires = new Date(value.cookie.expires || Date.now() + 86400000);
    this.db
      .execute(
        "INSERT INTO sessions (session_id,data,expires_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),expires_at=VALUES(expires_at)",
        [id, JSON.stringify(value), expires],
      )
      .then(() => callback())
      .catch(callback);
  }
  destroy(id, callback = () => {}) {
    this.db
      .execute("DELETE FROM sessions WHERE session_id = ?", [id])
      .then(() => callback())
      .catch(callback);
  }
  touch(id, value, callback) {
    this.set(id, value, callback);
  }
}
function csrf(req, res, next) {
  req.session.csrf ||= crypto.randomBytes(32).toString("hex");
  res.locals.csrfToken = req.session.csrf;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const token = req.body?._csrf || req.get("X-CSRF-Token");
    if (
      typeof token !== "string" ||
      Buffer.byteLength(token) !== Buffer.byteLength(req.session.csrf) ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))
    )
      return res
        .status(403)
        .send("Invalid form token. Reload the page and try again.");
  }
  next();
}
async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  const [users] = await global.db.execute(
    "SELECT id FROM users WHERE id = ? AND is_admin = 1",
    [req.session.user.id],
  );
  if (!users.length)
    return res.status(403).send("Administrator access required");
  next();
}
module.exports = { MysqlSessionStore, csrf, requireAdmin };
