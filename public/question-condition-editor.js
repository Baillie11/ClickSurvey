document.querySelectorAll("[data-condition-editor]").forEach((editor) => {
  const parent = editor.querySelector('[name="condition_question_id"]');
  const answer = editor.querySelector('[name="condition_value"]');
  function update(value = "") {
    const values = JSON.parse(parent.selectedOptions[0]?.dataset.values || "[]");
    answer.replaceChildren(new Option("Choose an answer…", ""));
    for (const choice of values) answer.add(new Option(choice, choice));
    answer.value = value;
    answer.disabled = !parent.value;
    answer.required = !!parent.value;
  }
  parent.addEventListener("change", () => update());
  update(answer.dataset.savedValue || "");
});
