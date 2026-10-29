const { transaction } = require('./models/db');
const { integer, email, text, bad } = require('./validation');

async function queueManualInvite(pool, body, token, adminId) {
  const surveyId = integer(body.survey_id, 'survey');
  const recipient = email(body.recipient_email);
  const name = text(body.recipient_name, 'recipient name', 255, true);
  return transaction(pool, async (db) => {
    const [[survey]] = await db.execute('SELECT id,status,brand_name FROM surveys WHERE id=? FOR UPDATE', [surveyId]);
    const [[existing]] = await db.execute('SELECT id,survey_id,recipient_email,recipient_name FROM survey_invites WHERE invite_token=?', [token]);
    if (existing) {
      if (existing.survey_id !== surveyId || existing.recipient_email !== recipient || (existing.recipient_name || null) !== name)
        throw bad('This form was already used for another invitation. Open a new send form.', 409);
      return existing.id;
    }
    if (!survey || survey.status !== 'Active') throw bad('Choose an active survey. Activate it from its Edit screen first.');
    const [suppressed] = await db.execute('SELECT id FROM suppressions WHERE email=? LIMIT 1', [recipient]);
    if (suppressed.length) throw bad('This address is unsubscribed or suppressed. No invitation was queued.');
    const [result] = await db.execute(
      "INSERT INTO survey_invites (survey_id,recipient_name,recipient_email,source_app,event_type,metadata_json,invite_token,status,due_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'Pending',UTC_TIMESTAMP(),DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 DAY),UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [surveyId, name, recipient, survey.brand_name || 'ClickSurvey', 'manual_invitation', JSON.stringify({ adminId, manual: true }), token],
    );
    return result.insertId;
  });
}
module.exports = { queueManualInvite };
