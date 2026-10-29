const nodemailer = require("nodemailer");
const addressparser = require("nodemailer/lib/addressparser");
const { emailHeader } = require("./validation");
const { transaction } = require("./models/db");
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function mailTransport() {
  if (!process.env.SMTP_HOST || !process.env.EMAIL_FROM)
    throw new Error("Configure SMTP_HOST and EMAIL_FROM");
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure:
      process.env.SMTP_SECURE === "true" ||
      Number(process.env.SMTP_PORT) === 465,
    requireTLS: process.env.SMTP_REQUIRE_TLS !== "false",
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}
async function deliverOne(db, transport) {
  // Commit the claim before SMTP. A crash during SMTP becomes DeliveryUnknown,
  // avoiding an automatic duplicate after an ambiguous SMTP acknowledgement.
  const invite = await transaction(db, async (connection) => {
    const [rows] = await connection.query(
      "SELECT si.*,s.title AS survey_title,s.status AS survey_status,s.email_subject,s.email_sender_name,s.brand_name FROM survey_invites si JOIN surveys s ON s.id=si.survey_id WHERE si.status IN ('Pending','Retry') AND si.due_at <= UTC_TIMESTAMP() ORDER BY si.due_at,si.id LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!rows.length) return null;
    const row = rows[0];
    const [suppressed] = await connection.execute(
      "SELECT id FROM suppressions WHERE email = ? LIMIT 1",
      [row.recipient_email],
    );
    if (
      suppressed.length ||
      row.survey_status !== "Active" ||
      new Date(row.expires_at) <= new Date()
    ) {
      await connection.execute(
        "UPDATE survey_invites SET status = ?,updated_at=UTC_TIMESTAMP() WHERE id = ?",
        [suppressed.length ? "Suppressed" : "Expired", row.id],
      );
      return { skipped: true };
    }
    await connection.execute(
      "UPDATE survey_invites SET status='Sending',attempts=attempts+1,updated_at=UTC_TIMESTAMP() WHERE id=?",
      [row.id],
    );
    return row;
  });
  if (!invite) return false;
  if (invite.skipped) return true;
  const base = process.env.BASE_URL.replace(/\/$/, "");
  const url = `${base}/r/${invite.invite_token}`;
  const unsubscribe = `${base}/unsubscribe/${invite.invite_token}`;
  const openPixel = `${base}/email-open/${invite.id}/${require('./email-tracking').trackingKey(invite.invite_token)}.gif`;
  await db.execute("UPDATE survey_invites SET email_tracking_enabled=1 WHERE id=? AND status='Sending'", [invite.id]);
  // Older events may contain arbitrary metadata; use only valid email overrides.
  const emailSettings = JSON.parse(invite.metadata_json || "{}").invitationEmail || {};
  function override(field) {
    try { return emailHeader(emailSettings[field], field); } catch { return null; }
  }
  const senderName = override("senderName") || invite.email_sender_name || invite.brand_name;
  let info;
  try {
    info = await transport.sendMail({
      from: senderName
        ? {
            name: senderName,
            address: addressparser(process.env.EMAIL_FROM, { flatten: true })[0].address,
          }
        : process.env.EMAIL_FROM,
      to: invite.recipient_email,
      subject: override("subject") || invite.email_subject || `Quick feedback about your ${invite.source_app} experience`,
      messageId: `<clicksurvey-${invite.id}-${invite.invite_token}@${new URL(base).hostname}>`,
      text: `Hi ${invite.recipient_name || "there"},\nPlease share your feedback: ${url}\nUnsubscribe from future surveys: ${unsubscribe}`,
      html: `<p>Hi ${escapeHtml(invite.recipient_name || "there")},</p><p>We would love your feedback on ${escapeHtml(invite.survey_title)}.</p><p><a href="${escapeHtml(url)}">Complete your survey</a></p><p><a href="${escapeHtml(unsubscribe)}">Unsubscribe from future surveys</a></p><p><small>This invitation records email image loads and survey-link visits to help us understand engagement.</small></p><img src="${escapeHtml(openPixel)}" width="1" height="1" alt="">`,
    });
    if (info.rejected?.length)
      throw Object.assign(new Error("Recipient rejected"), {
        responseCode: 550,
      });
  } catch (error) {
    const attempts = invite.attempts + 1;
    const ambiguous =
      !error.responseCode &&
      !["ECONNECTION", "EDNS", "EAUTH"].includes(error.code);
    const status = ambiguous
      ? "DeliveryUnknown"
      : attempts >= 5 || error.responseCode >= 500
        ? "Failed"
        : "Retry";
    const delay = Math.min(1440, 2 ** attempts);
    await db.execute(
      "UPDATE survey_invites SET status=?,last_error=?,due_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='Sending'",
      [
        status,
        String(error.code || error.responseCode || "SMTP_ERROR").slice(0, 100),
        delay,
        invite.id,
      ],
    );
    return true;
  }
  // Keep this outside the SMTP catch: a database outage after acceptance must
  // never mark an accepted email retryable.
  await db.execute(
    "UPDATE survey_invites SET status='Sent',sent_at=UTC_TIMESTAMP(),last_error=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND status='Sending'",
    [invite.id],
  );
  return true;
}
async function tick(db, transport) {
  await db.execute(
    "UPDATE survey_invites SET status='DeliveryUnknown',last_error='Worker interrupted during delivery',updated_at=UTC_TIMESTAMP() WHERE status='Sending' AND updated_at < DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 MINUTE)",
  );
  await db.execute("DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()");
  await db.execute(
    "INSERT INTO worker_state (id,heartbeat_at) VALUES (1,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE heartbeat_at=UTC_TIMESTAMP()",
  );
  for (let i = 0; i < 20; i++) {
    if (!(await deliverOne(db, transport))) break;
    await db.execute(
      "UPDATE worker_state SET heartbeat_at=UTC_TIMESTAMP() WHERE id=1",
    );
  }
}
async function run() {
  require("dotenv").config();
  const { validateConfig } = require("../app");
  validateConfig();
  const { initDb } = require("./models/db");
  const db = await initDb();
  const transport = mailTransport();
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      stopping = true;
    });
  try {
    while (!stopping) {
      try {
        await tick(db, transport);
      } catch (e) {
        console.error("Delivery worker failed:", e.code || e.name);
      }
      if (!stopping) await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    transport.close();
    await db.end();
  }
}
if (require.main === module)
  run().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { deliverOne, tick, escapeHtml, mailTransport };
