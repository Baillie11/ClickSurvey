document.querySelectorAll("[data-survey-logic]").forEach((form) => {
  const blocks = [...form.querySelectorAll("[data-question-id]")];
  const questions = blocks.map((block) => ({
    id: block.dataset.questionId,
    condition_question_id: block.dataset.conditionQuestionId,
    condition_value: block.dataset.conditionValue,
  }));
  function update() {
    const body = {};
    for (const block of blocks) {
      const controls = [...block.querySelectorAll("input, select, textarea")];
      const selected = controls.filter((c) => !["checkbox", "radio"].includes(c.type) || c.checked);
      body[`question_${block.dataset.questionId}`] = controls[0]?.type === "checkbox"
        ? selected.map((c) => c.value) : selected[0]?.value || "";
    }
    const visible = QuestionLogic.visibleQuestions(questions, body);
    for (const block of blocks) {
      block.hidden = !visible.has(block.dataset.questionId);
      for (const control of block.querySelectorAll("input, select, textarea")) {
        control.disabled = block.hidden;
        if (block.hidden) {
          if (["checkbox", "radio"].includes(control.type)) control.checked = false;
          else control.value = "";
        }
      }
    }
  }
  form.addEventListener("change", update);
  form.addEventListener("input", update);
  window.addEventListener("pageshow", update);
  update();
});
