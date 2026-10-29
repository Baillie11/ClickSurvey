const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../security");
const { questionInput, questionCondition, integer, bad } = require("../validation");
const { choices } = require("../../public/question-logic");
const { transaction } = require("../models/db");

async function activeQuestions(db, surveyId) {
  const [rows] = await db.execute(
    "SELECT * FROM survey_questions WHERE survey_id = ? AND archived = 0 ORDER BY sort_order,id",
    [surveyId],
  );
  return rows;
}
async function changeQuestions(surveyId, work) {
  return transaction(global.db, async (db) => {
    const [[survey]] = await db.execute("SELECT id FROM surveys WHERE id = ? FOR UPDATE", [surveyId]);
    if (!survey) throw bad("Survey not found", 404);
    return work(db, await activeQuestions(db, surveyId));
  });
}

router.use(requireAdmin);
router.param("surveyId", (req, res, next, value) => {
  integer(value, "survey ID");
  next();
});
router.param("id", (req, res, next, value) => {
  integer(value, "question ID");
  next();
});
router.use((req, res, next) => {
  if (req.method === "POST" && !req.path.endsWith("/delete"))
    questionInput(req.body);
  next();
});

router.get("/:surveyId/questions", async (req, res) => {
  const [surveyRows] = await global.db.execute(
    "SELECT * FROM surveys WHERE id = ?",
    [req.params.surveyId],
  );
  const survey = surveyRows[0];
  if (!survey) return res.redirect("/admin/surveys");
  const [questions] = await global.db.execute(
    "SELECT * FROM survey_questions WHERE survey_id = ? AND archived = 0 ORDER BY sort_order,id",
    [survey.id],
  );
  res.render("admin/surveys/questions", {
    title: `Questions - ${survey.title}`,
    survey,
    questions,
    choices,
    error: null,
  });
});

router.post("/:surveyId/questions", async (req, res) => {
  const { question_text, question_type, options_json, required } = req.body;
  await changeQuestions(req.params.surveyId, async (db, questions) => {
    const condition = questionCondition(req.body, questions);
    const sort_order = Math.max(0, ...questions.map((q) => q.sort_order)) + 1;
    await db.execute(
      "INSERT INTO survey_questions (survey_id, question_text, question_type, options_json, sort_order, required, condition_question_id, condition_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
      [
        req.params.surveyId,
        question_text,
        question_type,
        options_json || null,
        sort_order,
        required ? 1 : 0,
        condition.condition_question_id,
        condition.condition_value,
      ],
    );
  });
  res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
});

router.get("/:surveyId/questions/:id/edit", async (req, res) => {
  const [surveyRows] = await global.db.execute(
    "SELECT * FROM surveys WHERE id = ?",
    [req.params.surveyId],
  );
  const survey = surveyRows[0];
  const [rows] = await global.db.execute(
    "SELECT * FROM survey_questions WHERE id = ? AND survey_id = ?",
    [req.params.id, req.params.surveyId],
  );
  const question = rows[0];
  if (!survey || !question)
    return res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
  res.render("admin/surveys/question-edit", {
    title: `Edit Question - ${survey.title}`,
    survey,
    question,
    questions: await activeQuestions(global.db, req.params.surveyId),
    choices,
    error: null,
  });
});

router.post("/:surveyId/questions/:id", async (req, res) => {
  const { question_text, question_type, options_json, required } = req.body;
  await changeQuestions(req.params.surveyId, async (db, questions) => {
    const position = questions.findIndex((q) => String(q.id) === req.params.id);
    if (position < 0) throw bad("Question not found", 404);
    const condition = questionCondition(req.body, questions.slice(0, position));
    const allowed = choices(req.body);
    if (questions.some((q) => String(q.condition_question_id) === req.params.id && !allowed.includes(q.condition_value)))
      throw bad("Update the questions that depend on this answer before changing its type or options");
    await db.execute(
      "UPDATE survey_questions SET question_text = ?, question_type = ?, options_json = ?, required = ?, condition_question_id = ?, condition_value = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND survey_id = ?",
      [
        question_text,
        question_type,
        options_json || null,
        required ? 1 : 0,
        condition.condition_question_id,
        condition.condition_value,
        req.params.id,
        req.params.surveyId,
      ],
    );
  });
  res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
});

router.post("/:surveyId/questions/:id/delete", async (req, res) => {
  await changeQuestions(req.params.surveyId, async (db, questions) => {
    if (questions.some((q) => String(q.condition_question_id) === req.params.id))
      throw bad("Remove or change dependent question conditions before archiving this question");
    await db.execute(
      "UPDATE survey_questions SET archived=1,updated_at=UTC_TIMESTAMP() WHERE id = ? AND survey_id = ?",
      [req.params.id, req.params.surveyId],
    );
  });
  res.redirect(`/admin/surveys/${req.params.surveyId}/questions`);
});

module.exports = router;
