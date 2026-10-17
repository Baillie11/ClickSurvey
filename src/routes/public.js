const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('public/home', { title: 'ClickSurvey' });
});

router.get('/s/:surveyKey', async (req, res) => {
  const [surveys] = await global.db.execute('SELECT * FROM surveys WHERE survey_key = ? AND status = ?', [req.params.surveyKey, 'Active']);
  const survey = surveys[0];
  if (!survey) return res.status(404).render('404', { title: 'Survey not found' });
  const [questions] = await global.db.execute('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order ASC', [survey.id]);
  res.render('public/survey', { title: survey.title, survey, questions, error: null });
});

router.post('/s/:surveyKey', async (req, res) => {
  const [surveys] = await global.db.execute('SELECT * FROM surveys WHERE survey_key = ? AND status = ?', [req.params.surveyKey, 'Active']);
  const survey = surveys[0];
  if (!survey) return res.status(404).render('404', { title: 'Survey not found' });
  const [questions] = await global.db.execute('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order ASC', [survey.id]);

  const errors = [];
  const answers = [];
  for (const question of questions) {
    const answer = req.body[`question_${question.id}`];
    if (question.required && !answer) {
      errors.push(`${question.question_text} is required.`);
    }
    answers.push({ question, answer });
  }

  if (errors.length) {
    return res.render('public/survey', { title: survey.title, survey, questions, error: errors.join(' ')});
  }

  await global.db.execute('INSERT INTO survey_responses (survey_id, invite_id, submitted_at, ip_address, user_agent) VALUES (?, NULL, NOW(), ?, ?)', [survey.id, req.ip, req.headers['user-agent'] || '']);
  const [responseRows] = await global.db.execute('SELECT LAST_INSERT_ID() AS id');
  const responseId = responseRows[0].id;
  for (const { question, answer } of answers) {
    const answer_json = question.question_type === 'checkboxes' ? JSON.stringify(Array.isArray(answer) ? answer : [answer]) : null;
    const answer_text = question.question_type === 'checkboxes' ? JSON.stringify(Array.isArray(answer) ? answer : [answer]) : String(answer || '');
    await global.db.execute('INSERT INTO survey_answers (response_id, question_id, answer_text, answer_json) VALUES (?, ?, ?, ?)', [responseId, question.id, answer_text, answer_json]);
  }

  res.render('public/thank-you', { title: 'Thank you', survey });
});

router.get('/r/:token', async (req, res) => {
  const [invites] = await global.db.execute('SELECT si.*, s.title, s.thank_you_message, s.footer_text, s.brand_name, s.logo_url, s.primary_colour FROM survey_invites si LEFT JOIN surveys s ON si.survey_id = s.id WHERE invite_token = ?', [req.params.token]);
  const invite = invites[0];
  if (!invite || invite.status === 'Suppressed') return res.status(404).render('404', { title: 'Invite not found' });
  if (invite.status === 'Pending') {
    await global.db.execute('UPDATE survey_invites SET status = ?, opened_at = NOW() WHERE id = ?', ['Opened', invite.id]);
  }
  const [questions] = await global.db.execute('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order ASC', [invite.survey_id]);
  res.render('public/survey-invite', { title: invite.title || 'Survey Invite', invite, questions, error: null });
});

router.post('/r/:token', async (req, res) => {
  const [invites] = await global.db.execute('SELECT si.*, s.title, s.thank_you_message, s.footer_text, s.brand_name, s.logo_url, s.primary_colour FROM survey_invites si LEFT JOIN surveys s ON si.survey_id = s.id WHERE invite_token = ?', [req.params.token]);
  const invite = invites[0];
  if (!invite || invite.status === 'Suppressed') return res.status(404).render('404', { title: 'Invite not found' });
  const [questions] = await global.db.execute('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order ASC', [invite.survey_id]);

  const errors = [];
  const answers = [];
  for (const question of questions) {
    const answer = req.body[`question_${question.id}`];
    if (question.required && !answer) {
      errors.push(`${question.question_text} is required.`);
    }
    answers.push({ question, answer });
  }

  if (errors.length) {
    return res.render('public/survey-invite', { title: invite.title || 'Survey Invite', invite, questions, error: errors.join(' ')});
  }

  await global.db.execute('INSERT INTO survey_responses (survey_id, invite_id, submitted_at, ip_address, user_agent) VALUES (?, ?, NOW(), ?, ?)', [invite.survey_id, invite.id, req.ip, req.headers['user-agent'] || '']);
  const [responseRows] = await global.db.execute('SELECT LAST_INSERT_ID() AS id');
  const responseId = responseRows[0].id;
  for (const { question, answer } of answers) {
    const answer_json = question.question_type === 'checkboxes' ? JSON.stringify(Array.isArray(answer) ? answer : [answer]) : null;
    const answer_text = question.question_type === 'checkboxes' ? JSON.stringify(Array.isArray(answer) ? answer : [answer]) : String(answer || '');
    await global.db.execute('INSERT INTO survey_answers (response_id, question_id, answer_text, answer_json) VALUES (?, ?, ?, ?)', [responseId, question.id, answer_text, answer_json]);
  }

  await global.db.execute('UPDATE survey_invites SET status = ?, completed_at = NOW() WHERE id = ?', ['Completed', invite.id]);
  res.render('public/thank-you', { title: 'Thank you', survey: { title: invite.title || 'Survey', thank_you_message: invite.thank_you_message } });
});

module.exports = router;
