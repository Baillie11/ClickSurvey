const express = require("express");
const { transaction } = require("../models/db");
const { answersFor, bad } = require("../validation");
const router = express.Router();
router.get('/email-open/:id/:key', async (req, res) => {
  const { trackingKey, pixel } = require('../email-tracking');
  res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Content-Type': 'image/gif' });
  if (/^[1-9]\d{0,9}$/.test(req.params.id) && /^[a-f0-9]{64}\.gif$/.test(req.params.key) && req.method === 'GET') {
    const [[invite]] = await global.db.execute('SELECT invite_token FROM survey_invites WHERE id=? AND email_tracking_enabled=1', [req.params.id]);
    if (invite && require('crypto').timingSafeEqual(Buffer.from(trackingKey(invite.invite_token)), Buffer.from(req.params.key.slice(0, 64)))) {
      await global.db.execute("UPDATE survey_invites SET email_opened_at=COALESCE(email_opened_at,UTC_TIMESTAMP()) WHERE id=? AND status IN ('Sending','Sent','Opened','Completed') AND expires_at>UTC_TIMESTAMP() AND NOT EXISTS (SELECT 1 FROM suppressions WHERE email=survey_invites.recipient_email)", [req.params.id]);
    }
  }
  res.send(pixel);
});
const inviteQuery =
  "SELECT si.*,s.title,s.thank_you_message,s.footer_text,s.status AS survey_status,EXISTS(SELECT 1 FROM suppressions sp WHERE sp.email=si.recipient_email) AS suppressed FROM survey_invites si JOIN surveys s ON s.id=si.survey_id WHERE si.invite_token = ?";
function usable(invite) {
  if (
    !invite ||
    invite.suppressed ||
    invite.survey_status !== "Active" ||
    !["Sent", "Opened"].includes(invite.status) ||
    !invite.expires_at ||
    new Date(invite.expires_at) <= new Date()
  )
    throw bad(
      "This invitation is unavailable, expired or already completed.",
      410,
    );
}
async function questions(db, id) {
  const [rows] = await db.execute(
    "SELECT * FROM survey_questions WHERE survey_id = ? AND archived = 0 ORDER BY sort_order,id",
    [id],
  );
  return rows;
}
async function save(db, surveyId, inviteId, answers, req) {
  const [response] = await db.execute(
    "INSERT INTO survey_responses (survey_id,invite_id,completion_key,submitted_at,ip_address,user_agent) VALUES (?,?,?,UTC_TIMESTAMP(),?,?)",
    [surveyId, inviteId, inviteId, req.ip, req.get("user-agent") || ""],
  );
  for (const answer of answers)
    await db.execute(
      "INSERT INTO survey_answers (response_id,question_id,answer_text,answer_json) VALUES (?,?,?,?)",
      [response.insertId, answer.questionId, answer.text, answer.json],
    );
}
router.get("/", (req, res) =>
  res.render("public/home", { title: "ClickSurvey" }),
);
router.get("/s/:surveyKey", async (req, res) => {
  const [[survey]] = await global.db.execute(
    "SELECT * FROM surveys WHERE survey_key=? AND status='Active'",
    [req.params.surveyKey],
  );
  if (!survey) throw bad("Survey not found", 404);
  res.render("public/survey", {
    title: survey.title,
    survey,
    questions: await questions(global.db, survey.id),
    error: null,
  });
});
router.post("/s/:surveyKey", async (req, res) => {
  const survey = await transaction(global.db, async (db) => {
    const [[survey]] = await db.execute(
      "SELECT * FROM surveys WHERE survey_key=? AND status='Active' FOR UPDATE",
      [req.params.surveyKey],
    );
    if (!survey) throw bad("Survey not found", 404);
    await save(
      db,
      survey.id,
      null,
      answersFor(await questions(db, survey.id), req.body),
      req,
    );
    return survey;
  });
  res.render("public/thank-you", { title: "Thank you", survey });
});
router.get("/r/:token", async (req, res) => {
  const [[invite]] = await global.db.execute(inviteQuery, [req.params.token]);
  usable(invite);
  await global.db.execute(
    "UPDATE survey_invites SET status='Opened',opened_at=COALESCE(opened_at,UTC_TIMESTAMP()),updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('Sent','Opened')",
    [invite.id],
  );
  res.render("public/survey-invite", {
    title: invite.title,
    invite,
    questions: await questions(global.db, invite.survey_id),
    error: null,
  });
});
router.post("/r/:token", async (req, res) => {
  const invite = await transaction(global.db, async (db) => {
    const [[invite]] = await db.execute(inviteQuery + " FOR UPDATE", [
      req.params.token,
    ]);
    usable(invite);
    await save(
      db,
      invite.survey_id,
      invite.id,
      answersFor(await questions(db, invite.survey_id), req.body),
      req,
    );
    await db.execute(
      "UPDATE survey_invites SET status='Completed',completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=?",
      [invite.id],
    );
    return invite;
  });
  res.render("public/thank-you", { title: "Thank you", survey: invite });
});
// GET only confirms; email scanners cannot unsubscribe a recipient by visiting.
router.get("/unsubscribe/:token", async (req, res) => {
  const [[invite]] = await global.db.execute(
    "SELECT id FROM survey_invites WHERE invite_token=?",
    [req.params.token],
  );
  if (!invite) throw bad("Link not found", 404);
  res.render("public/unsubscribe", {
    title: "Unsubscribe",
    token: req.params.token,
  });
});
router.post("/unsubscribe/:token", async (req, res) => {
  await transaction(global.db, async (db) => {
    const [[invite]] = await db.execute(
      "SELECT * FROM survey_invites WHERE invite_token=? FOR UPDATE",
      [req.params.token],
    );
    if (!invite) throw bad("Link not found", 404);
    await db.execute(
      "INSERT INTO suppressions (email,reason,source_app,created_at) VALUES (?,'Recipient unsubscribe',?,UTC_TIMESTAMP())",
      [invite.recipient_email, invite.source_app],
    );
    await db.execute(
      "UPDATE survey_invites SET status='Suppressed',updated_at=UTC_TIMESTAMP() WHERE recipient_email=? AND status IN ('Pending','Retry','Sent','Opened')",
      [invite.recipient_email],
    );
  });
  res
    .type("text")
    .send("You have been unsubscribed from future survey invitations.");
});
module.exports = router;
