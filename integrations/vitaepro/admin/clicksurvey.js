"use strict";
// Event submission is live; signed completion callbacks remain separately disabled.
const crypto = require("crypto");
const { rows, transaction, audit } = require("./db");
const { wrap, hash } = require("./security");
const { bad } = require("./communications");
function verifyWebhook(raw, timestamp, signature, now = Date.now()) {
  const key = process.env.CLICKSURVEY_WEBHOOK_SECRET;
  if (
    !key ||
    key.length < 32 ||
    !/^\d{10}$/.test(timestamp || "") ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^sha256=[a-f0-9]{64}$/.test(signature || "")
  )
    return false;
  const expected = crypto
    .createHmac("sha256", key)
    .update(timestamp + ".")
    .update(raw)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature.slice(7)),
  );
}
function webhook(pool) {
  return wrap(async (req, res) => {
    if (process.env.CLICKSURVEY_WEBHOOK_ENABLED !== "true")
      return res
        .status(503)
        .json({ error: "Completion webhook not activated" });
    if (
      !Buffer.isBuffer(req.rawBody) ||
      !verifyWebhook(
        req.rawBody,
        req.get("x-clicksurvey-timestamp"),
        req.get("x-clicksurvey-signature"),
      )
    )
      return res.status(401).json({ error: "Invalid signature" });
    const b = req.body;
    if (
      typeof b.eventId !== "string" ||
      !/^[\w:.-]{1,100}$/.test(b.eventId) ||
      typeof b.surveyId !== "string" ||
      b.surveyId.length > 100 ||
      b.type !== "survey.completed" ||
      (b.rating != null &&
        (!Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5)) ||
      Object.keys(b).some(
        (k) => !["eventId", "surveyId", "type", "rating"].includes(k),
      )
    )
      throw bad("Only anonymous aggregate completion fields are accepted");
    const digest = hash(req.rawBody);
    await transaction(pool, async (db) => {
      const [old] = await rows(
        db,
        "SELECT payload_hash FROM vp_survey_completions WHERE event_id=? FOR UPDATE",
        [b.eventId],
      );
      if (old) {
        if (old.payload_hash !== digest)
          throw bad("Event conflicts with prior payload", 409);
        return;
      }
      await db.execute(
        "INSERT INTO vp_survey_completions VALUES (?,?,?,?,UTC_TIMESTAMP())",
        [b.eventId, b.surveyId, b.rating ?? null, digest],
      );
    });
    res.json({ ok: true });
  });
}
function mount(router, pool, auth) {
  router.get(
    "/api/clicksurvey",
    wrap(async (req, res) =>
      res.json({
        enabled: process.env.CLICKSURVEY_ENABLED === "true",
        webhookEnabled: process.env.CLICKSURVEY_WEBHOOK_ENABLED === "true",
        limitations:
          "ClickSurvey currently exposes event submission/status only. Response retrieval and completion reporting require changes in ClickSurvey. No anonymous feedback is linked to customer identities.",
        triggers: await rows(
          pool,
          "SELECT * FROM vp_survey_triggers ORDER BY name",
        ),
        invitations: await rows(
          pool,
          "SELECT status,COUNT(*) AS count FROM vp_survey_outbox GROUP BY status",
        ),
        responses:
          process.env.CLICKSURVEY_WEBHOOK_ENABLED === "true"
            ? await rows(
                pool,
                "SELECT survey_id,COUNT(*) AS responses,AVG(rating) AS satisfaction FROM vp_survey_completions GROUP BY survey_id",
              )
            : null,
      }),
    ),
  );
  router.post(
    "/api/clicksurvey/triggers/:name",
    auth.permit("super"),
    wrap(async (req, res) => {
      if (
        typeof req.body.enabled !== "boolean" ||
        !Number.isInteger(req.body.threshold) ||
        req.body.threshold < 1 ||
        req.body.threshold > 3650
      )
        throw bad("Invalid trigger");
      await transaction(pool, async (db) => {
        const [r] = await db.execute(
          "UPDATE vp_survey_triggers SET enabled=?,threshold_value=? WHERE name=?",
          [req.body.enabled, req.body.threshold, req.params.name],
        );
        if (!r.affectedRows) throw bad("Trigger not found", 404);
        await audit(
          db,
          req.admin.admin_id,
          "survey.trigger.updated",
          req.params.name,
        );
      });
      res.json({ ok: true });
    }),
  );
}
async function sendEvent(payload, fetcher = fetch) {
  if (process.env.CLICKSURVEY_ENABLED !== "true")
    throw bad("ClickSurvey disabled", 409);
  const url = new URL(process.env.CLICKSURVEY_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw bad("HTTPS ClickSurvey base URL required");
  if (!process.env.CLICKSURVEY_API_KEY)
    throw bad("ClickSurvey API key required");
  const response = await fetcher(new URL(url.href.replace(/\/$/, "") + "/api/events"), {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.CLICKSURVEY_API_KEY,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || data.success !== true || data.eventId !== payload.eventId)
    throw bad("ClickSurvey rejected event", 502);
  return data;
}
module.exports = { mount, webhook, verifyWebhook, sendEvent };
