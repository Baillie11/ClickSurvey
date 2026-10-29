(function (root) {
  function choices(question) {
    if (question.question_type === "yes_no") return ["Yes", "No"];
    if (question.question_type === "star_rating") return ["1", "2", "3", "4", "5"];
    if (question.question_type === "rating_1_10")
      return Array.from({ length: 10 }, (_, i) => String(i + 1));
    if (["dropdown", "multiple_choice", "checkboxes"].includes(question.question_type))
      return JSON.parse(question.options_json || "[]");
    return [];
  }
  // Evaluate in display order: a hidden or missing parent can never reveal a child.
  function visibleQuestions(questions, body) {
    const visible = new Set();
    for (const q of questions) {
      const parent = q.condition_question_id;
      const answer = body[`question_${parent}`];
      const matches = Array.isArray(answer)
        ? answer.includes(q.condition_value)
        : typeof answer === "string" && answer.trim() !== "" && answer.trim() === q.condition_value;
      if (!parent || (visible.has(String(parent)) && matches)) visible.add(String(q.id));
    }
    return visible;
  }
  const api = { choices, visibleQuestions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QuestionLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
