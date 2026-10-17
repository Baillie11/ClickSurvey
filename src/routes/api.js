const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const router = express.Router();

async function verifyApiKey(rawKey) {
  const [clients] = await global.db.execute('SELECT * FROM api_clients WHERE status = ?', ['Active']);
  for (const client of clients) {
    const match = await bcrypt.compare(rawKey, client.api_key_hash);
    if (match) return client;
  }
  return null;
}

async function createInvite(event, rule) {
  const inviteToken = crypto.randomBytes(16).toString('hex');
  const status = 'Pending';
  await global.db.execute(
    'INSERT INTO survey_invites (survey_id, recipient_name, recipient_email, source_app, event_type, metadata_json, invite_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
    [rule.survey_id, event.recipient.name, event.recipient.email, event.sourceApp, event.eventType, JSON.stringify(event.metadata || {}), inviteToken, status]
  );
  const [rows] = await global.db.execute('SELECT LAST_INSERT_ID() AS id');
  return { id: rows[0].id, inviteToken };
}

async function sendInviteEmail(inviteId) {
  const [rows] = await global.db.execute('SELECT si.*, s.title as survey_title, s.thank_you_message, s.brand_name, s.logo_url, s.primary_colour FROM survey_invites si LEFT JOIN surveys s ON si.survey_id = s.id WHERE si.id = ?', [inviteId]);
  const invite = rows[0];
  if (!invite) return;
  const suppression = await global.db.execute('SELECT id FROM suppressions WHERE email = ?', [invite.recipient_email]);
  if (suppression[0].length) {
    await global.db.execute('UPDATE survey_invites SET status = ?, updated_at = NOW() WHERE id = ?', ['Suppressed', inviteId]);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const surveyUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/r/${invite.invite_token}`;
  const html = `<p>Hi ${invite.recipient_name || 'there'},</p>
    <p>We’d love your feedback on <strong>${invite.survey_title}</strong>.</p>
    <p><a href="${surveyUrl}" style="display:inline-block;padding:12px 18px;background-color:#0d6efd;color:#fff;text-decoration:none;border-radius:4px;">Complete your survey</a></p>
    <p>Thanks,<br>${invite.source_app}</p>
    <p style="font-size:0.9em;color:#666;">If you don’t want future surveys, you can reply with STOP.</p>`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: invite.recipient_email,
      subject: `Quick feedback about your ${invite.source_app} experience`,
      html
    });
    await global.db.execute('UPDATE survey_invites SET status = ?, sent_at = NOW(), updated_at = NOW() WHERE id = ?', ['Sent', inviteId]);
  } catch (error) {
    await global.db.execute('UPDATE survey_invites SET status = ?, updated_at = NOW() WHERE id = ?', ['Failed', inviteId]);
  }
}

router.post('/events', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing API key' });
  }
  const client = await verifyApiKey(token);
  if (!client) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  const { sourceApp, eventType, recipient, metadata } = req.body;
  if (!sourceApp || !eventType || !recipient || !recipient.email) {
    return res.status(400).json({ success: false, error: 'sourceApp, eventType, and recipient email are required' });
  }

  await global.db.execute(
    'INSERT INTO events (api_client_id, source_app, event_type, recipient_name, recipient_email, metadata_json, received_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
    [client.id, sourceApp, eventType, recipient.name || null, recipient.email, JSON.stringify(metadata || {})]
  );

  const [rules] = await global.db.execute(
    'SELECT * FROM automation_rules WHERE source_app = ? AND event_type = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [sourceApp, eventType, 'Active']
  );
  if (!rules.length) {
    return res.json({ success: true, message: 'Event received, no matching automation rule', inviteCreated: false });
  }

  const rule = rules[0];
  const invite = await createInvite(req.body, rule);
  await sendInviteEmail(invite.id);

  res.json({ success: true, message: 'Event received and survey invitation created', inviteCreated: true });
});

module.exports = router;
