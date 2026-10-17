const express = require('express');
const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

router.use(requireAuth);

router.get('/:surveyId/questions', async (req, res) => {
  const [surveyRows] = await global.db.execute('SELECT * FROM surveys WHERE id = ?', [req.params.surveyId]);
  const survey = surveyRows[0];
  if (!survey) return res.redirect('/admin/surveys');
  const [questions] = await global.db.execute('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order ASC', [survey.id]);
  res.render('admin/surveys/questions', { title: `Questions - ${survey.title}`, survey, questions, error: null });
});

router.post('/:surveyId/questions', async (req, res) => {
  const { question_text, question_type, options_json, required } = req.body;
  const [countRows] = await global.db.execute('SELECT COUNT(*) as count FROM survey_questions WHERE survey_id = ?', [req.params.surveyId]);
  const sort_order = countRows[0].count + 1;
  await global.db.execute(
    'INSERT INTO survey_questions (survey_id, question_text, question_type, options_json, sort_order, required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())',
    [req.params.surveyId, question_text, question_type, options_json || null, sort_order, required ? 1 : 0]
  );
  res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
});

router.get('/:surveyId/questions/:id/edit', async (req, res) => {
  const [surveyRows] = await global.db.execute('SELECT * FROM surveys WHERE id = ?', [req.params.surveyId]);
  const survey = surveyRows[0];
  const [rows] = await global.db.execute('SELECT * FROM survey_questions WHERE id = ? AND survey_id = ?', [req.params.id, req.params.surveyId]);
  const question = rows[0];
  if (!survey || !question) return res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
  res.render('admin/surveys/question-edit', { title: `Edit Question - ${survey.title}`, survey, question, error: null });
});

router.post('/:surveyId/questions/:id', async (req, res) => {
  const { question_text, question_type, options_json, required } = req.body;
  await global.db.execute(
    'UPDATE survey_questions SET question_text = ?, question_type = ?, options_json = ?, required = ?, updated_at = NOW() WHERE id = ? AND survey_id = ?',
    [question_text, question_type, options_json || null, required ? 1 : 0, req.params.id, req.params.surveyId]
  );
  res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
});

router.post('/:surveyId/questions/:id/delete', async (req, res) => {
  await global.db.execute('DELETE FROM survey_questions WHERE id = ? AND survey_id = ?', [req.params.id, req.params.surveyId]);
  res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
});

module.exports = router;
