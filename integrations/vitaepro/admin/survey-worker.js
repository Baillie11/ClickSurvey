"use strict";
const { rows } = require("./db");
const { sendEvent } = require("./clicksurvey");
const { hash } = require("./security");
async function prepare(pool) {
  if (
    process.env.CLICKSURVEY_ENABLED !== "true" ||
    process.env.CLICKSURVEY_INVITATIONS_APPROVED !== "true"
  )
    return { disabled: true };
  const activatedAt = process.env.CLICKSURVEY_ACTIVATED_AT;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(activatedAt || ""))
    return { disabled: true, reason: "activation_time_required" };
  const preparation = await pool.getConnection();
  let locked = false;
  try {
  const [[lock]] = await preparation.query("SELECT GET_LOCK('vp_survey_prepare',0) AS ok");
  if (!lock.ok) return { busy: true };
  locked = true;
  const triggers = await rows(
    preparation,
    "SELECT * FROM vp_survey_triggers WHERE enabled=1",
  );
  let count = 0;
  for (const trigger of triggers) {
    const conditions = {
      first_cover_letter:
        "EXISTS(SELECT 1 FROM vp_events e WHERE e.user_id=u.id AND e.kind='cover_letter' AND e.created_at>=?)",
      several_documents:
        "(SELECT COUNT(*) FROM vp_events e WHERE e.user_id=u.id AND e.kind IN ('cover_letter','response'))>=?",
      inactive:
        "EXISTS(SELECT 1 FROM vp_events e WHERE e.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM vp_events e WHERE e.user_id=u.id AND e.created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY))",
      before_subscriptions: "1=1",
    };
    const condition = conditions[trigger.name];
    if (!condition) continue;
    const params = ["VitaePro:" + trigger.name + ":"];
    if (trigger.name === "first_cover_letter") params.push(activatedAt);
    if (["several_documents", "inactive"].includes(trigger.name))
      params.push(trigger.threshold_value);
    params.push(activatedAt);
    // Bounded pages, stable keys, and no repeat invitations for a given trigger/user.
    const users = await rows(
      preparation,
      `SELECT u.id,u.username FROM users u JOIN vp_customer_state s ON s.user_id=u.id AND s.marketing_consent=1 AND s.status='active'
      WHERE NOT EXISTS(SELECT 1 FROM vp_survey_outbox o WHERE o.event_id=CONCAT(?,u.id))
      AND NOT EXISTS(SELECT 1 FROM vp_survey_outbox recent WHERE recent.user_id=u.id AND recent.created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY))
      AND NOT EXISTS(SELECT 1 FROM vp_suppressions p WHERE p.email=u.username) AND ${condition}
      AND EXISTS(SELECT 1 FROM vp_events fresh WHERE fresh.user_id=u.id AND fresh.kind IN ('cover_letter','response','submission') AND fresh.created_at>=?)
      ORDER BY u.id LIMIT 100`,
      params,
    );
    for (const user of users) {
      const eventId = "VitaePro:" + trigger.name + ":" + user.id;
      const payload = {
        eventId,
        sourceApp: "VitaePro",
        eventType: trigger.name,
        recipient: { email: user.username },
        metadata: {},
      };
      await preparation.execute(
        "INSERT IGNORE INTO vp_survey_outbox (event_id,user_id,payload,next_attempt,created_at) VALUES (?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
        [eventId, user.id, JSON.stringify(payload)],
      );
      count++;
    }
  }
  return { prepared: count };
  } finally {
    if (locked) await preparation.query("SELECT RELEASE_LOCK('vp_survey_prepare')").catch(() => {});
    preparation.release();
  }
}
async function dispatch(pool, sender = sendEvent) {
  if (
    process.env.CLICKSURVEY_ENABLED !== "true" ||
    process.env.CLICKSURVEY_INVITATIONS_APPROVED !== "true"
  )
    return { disabled: true };
  const db = await pool.getConnection();
  try {
    const [[lock]] = await db.query(
      "SELECT GET_LOCK('vp_survey_dispatch',0) AS ok",
    );
    if (!lock.ok) return { busy: true };
    const [job] = await rows(
      db,
      "SELECT * FROM vp_survey_outbox WHERE status='pending' AND next_attempt<=UTC_TIMESTAMP() ORDER BY next_attempt LIMIT 1",
    );
    if (!job) return { idle: true };
    const [eligible] = await rows(
      db,
      "SELECT u.id FROM users u JOIN vp_customer_state s ON s.user_id=u.id AND s.marketing_consent=1 AND s.status='active' WHERE u.id=? AND NOT EXISTS(SELECT 1 FROM vp_suppressions p WHERE p.email=u.username)",
      [job.user_id],
    );
    if (!eligible) {
      await db.execute(
        "UPDATE vp_survey_outbox SET status='suppressed' WHERE event_id=?",
        [job.event_id],
      );
      return { suppressed: true };
    }
    // Persist next retry before network I/O; original ID and payload survive crashes.
    await db.execute(
      "UPDATE vp_survey_outbox SET attempts=attempts+1,next_attempt=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND) WHERE event_id=?",
      [Math.min(86400, 60 * 2 ** job.attempts), job.event_id],
    );
    try {
      const result = await sender(JSON.parse(job.payload));
      await db.execute(
        "UPDATE vp_survey_outbox SET status=?,invite_id=? WHERE event_id=?",
        [
          result.inviteCreated ? "accepted" : "no_matching_rule",
          result.inviteId == null ? null : String(result.inviteId),
          job.event_id,
        ],
      );
      return { accepted: true };
    } catch (e) {
      if (job.attempts >= 7)
        await db.execute(
          "UPDATE vp_survey_outbox SET status='failed' WHERE event_id=?",
          [job.event_id],
        );
      return { retry: job.attempts < 7 };
    }
  } finally {
    await db.query("SELECT RELEASE_LOCK('vp_survey_dispatch')");
    db.release();
  }
}
module.exports = { prepare, dispatch };
