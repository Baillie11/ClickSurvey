const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { eventInput, bad } = require("../validation");
const { transaction } = require("../models/db");
const router = express.Router();
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function authenticate(req, res, next) {
  const match = /^Bearer (cs_([a-f0-9]{24})_[a-f0-9]{40})$/.exec(
    req.get("Authorization") || "",
  );
  if (!match) throw bad("Invalid or missing API key", 401);
  const [rows] = await global.db.execute(
    "SELECT * FROM api_clients WHERE key_id = ? AND status = 'Active'",
    [match[2]],
  );
  if (!rows[0] || !(await bcrypt.compare(match[1], rows[0].api_key_hash)))
    throw bad("Invalid or missing API key", 401);
  req.apiClient = rows[0];
  next();
}
router.use(authenticate);
router.post("/events", async (req, res) => {
  if (!req.is("application/json"))
    throw bad("Content-Type must be application/json", 415);
  const event = eventInput(req.body, req.get("Idempotency-Key"));
  const client = req.apiClient;
  if (client.client_name !== event.sourceApp)
    throw bad("API key cannot use this sourceApp", 403);
  const hash = crypto
    .createHash("sha256")
    .update(canonical(event))
    .digest("hex");
  const result = await transaction(global.db, async (db) => {
    let insert;
    try {
      [insert] = await db.execute(
        "INSERT INTO events (api_client_id,event_key,payload_hash,source_app,event_type,recipient_name,recipient_email,metadata_json,received_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP())",
        [
          client.id,
          event.eventId,
          hash,
          event.sourceApp,
          event.eventType,
          event.recipient.name,
          event.recipient.email,
          JSON.stringify(event.metadata),
        ],
      );
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY") throw error;
      const [[saved]] = await db.execute(
        "SELECT * FROM events WHERE api_client_id = ? AND event_key = ? FOR UPDATE",
        [client.id, event.eventId],
      );
      if (saved.payload_hash !== hash)
        throw bad("Event ID already used with different data", 409);
      return {
        eventId: event.eventId,
        inviteId: saved.invite_id || null,
        duplicate: true,
      };
    }
    const [rules] = await db.execute(
      "SELECT ar.* FROM automation_rules ar JOIN surveys s ON s.id=ar.survey_id WHERE ar.source_app = ? AND ar.event_type = ? AND ar.status = 'Active' AND s.status = 'Active' ORDER BY ar.id DESC LIMIT 1",
      [event.sourceApp, event.eventType],
    );
    if (!rules.length)
      return { eventId: event.eventId, inviteId: null, duplicate: false };
    const rule = rules[0];
    const allowed = JSON.parse(client.allowed_surveys_json || "[]");
    if (!Array.isArray(allowed) || !allowed.includes(rule.survey_id))
      throw bad("API key cannot trigger this survey", 403);
    const [invite] = await db.execute(
      "INSERT INTO survey_invites (survey_id,recipient_name,recipient_email,source_app,event_type,metadata_json,invite_token,status,due_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'Pending',DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),DATE_ADD(DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),INTERVAL 30 DAY),UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [
        rule.survey_id,
        event.recipient.name,
        event.recipient.email,
        event.sourceApp,
        event.eventType,
        JSON.stringify(event.metadata),
        crypto.randomBytes(32).toString("hex"),
        rule.delay_minutes,
        rule.delay_minutes,
      ],
    );
    await db.execute("UPDATE events SET invite_id = ? WHERE id = ?", [
      invite.insertId,
      insert.insertId,
    ]);
    return {
      eventId: event.eventId,
      inviteId: invite.insertId,
      duplicate: false,
    };
  });
  res
    .status(result.duplicate ? 200 : 202)
    .json({
      success: true,
      ...result,
      inviteCreated: !!result.inviteId,
      deliveryStatus: result.inviteId
        ? "queued; query event status for delivery"
        : "no_matching_rule",
    });
});
router.get("/events/:eventId", async (req, res) => {
  const [rows] = await global.db.execute(
    "SELECT e.event_key AS eventId, e.invite_id AS inviteId, si.status AS deliveryStatus, si.attempts, si.sent_at AS sentAt, si.due_at AS dueAt FROM events e LEFT JOIN survey_invites si ON si.id=e.invite_id WHERE e.api_client_id = ? AND e.event_key = ?",
    [req.apiClient.id, req.params.eventId],
  );
  if (!rows.length) throw bad("Event not found", 404);
  res.json({
    success: true,
    ...rows[0],
    deliveryStatus: rows[0].deliveryStatus || "no_matching_rule",
  });
});
module.exports = router;
module.exports.canonical = canonical;
