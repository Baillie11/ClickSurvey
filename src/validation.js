const { visibleQuestions, choices } = require("../public/question-logic");
function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function text(value, name, max = 255, optional = false) {
  if (optional && (value === undefined || value === null || value === ""))
    return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(value)
  )
    throw bad(`Invalid ${name}`);
  return value.trim();
}
function emailHeader(value, name) {
  if (typeof value === "string" && /[\r\n]/.test(value))
    throw bad("Invalid " + name + ": use a single line");
  return text(typeof value === "string" ? value.trim() : value, name, 255, true);
}
function email(value) {
  const result = text(value, "email", 254).toLowerCase();
  if (!/^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(result))
    throw bad("Invalid email");
  return result;
}
function integer(value, name, min = 1, max = 2147483647) {
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw bad(`Invalid ${name}`);
  return Number(value);
}
function eventInput(body, key) {
  if (!body || Array.isArray(body) || typeof body !== "object")
    throw bad("JSON object required");
  const sourceApp = text(body.sourceApp, "sourceApp");
  const eventType = text(body.eventType, "eventType");
  const eventId = text(key || body.eventId, "eventId / Idempotency-Key", 128);
  if (!/^[\x21-\x7e]+$/.test(eventId))
    throw bad("Event identifier must be printable ASCII");
  if (key && body.eventId && key !== body.eventId)
    throw bad("Conflicting event identifiers");
  if (!body.recipient || Array.isArray(body.recipient))
    throw bad("recipient required");
  const recipient = {
    name: text(body.recipient.name, "recipient name", 255, true),
    email: email(body.recipient.email),
  };
  const metadata = body.metadata ?? {};
  if (
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata === null ||
    Buffer.byteLength(JSON.stringify(metadata)) > 16000
  )
    throw bad("Invalid metadata (object, maximum 16KB)");
  if (Object.hasOwn(metadata, "invitationEmail")) {
    const settings = metadata.invitationEmail;
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw bad("Invalid invitationEmail settings");
    for (const [field, value] of Object.entries(settings)) {
      if (!["subject", "senderName"].includes(field))
        throw bad("Unknown invitationEmail setting");
      emailHeader(value, field);
    }
  }
  return { eventId, sourceApp, eventType, recipient, metadata };
}
const types = [
  "short_text",
  "long_text",
  "email",
  "number",
  "dropdown",
  "multiple_choice",
  "checkboxes",
  "star_rating",
  "rating_1_10",
  "yes_no",
  "name",
];
function questionInput(body) {
  body.question_text = text(body.question_text, "question text", 2000);
  if (!types.includes(body.question_type)) throw bad("Invalid question type");
  if (
    ["dropdown", "multiple_choice", "checkboxes"].includes(body.question_type)
  ) {
    let options;
    try {
      options = JSON.parse(body.options_json);
    } catch {
      throw bad("Options must be a JSON array");
    }
    if (
      !Array.isArray(options) ||
      !options.length ||
      options.length > 100 ||
      options.some(
        (x) => typeof x !== "string" || !x.trim() || x.length > 255,
      ) ||
      new Set(options).size !== options.length
    )
      throw bad("Provide 1–100 unique text options");
    body.options_json = JSON.stringify(options);
  } else body.options_json = null;
}
function answersFor(questions, body) {
  const visible = visibleQuestions(questions, body);
  return questions.filter((q) => visible.has(String(q.id))).map((q) => {
    let value = body[`question_${q.id}`];
    const multi = q.question_type === "checkboxes";
    if (multi)
      value = value === undefined ? [] : Array.isArray(value) ? value : [value];
    else value = value === undefined ? "" : value;
    if (
      multi
        ? value.some((x) => typeof x !== "string" || x.length > 10000)
        : typeof value !== "string" || value.length > 10000
    )
      throw bad(`Invalid answer: ${q.question_text}`);
    if (!multi) value = value.trim();
    if (q.required && (multi ? !value.length : !value))
      throw bad(`${q.question_text} is required`);
    if ((multi && value.length) || (!multi && value !== "")) {
      if (
        ["dropdown", "multiple_choice", "checkboxes"].includes(q.question_type)
      ) {
        const options = JSON.parse(q.options_json || "[]");
        if ((multi ? value : [value]).some((x) => !options.includes(x)))
          throw bad(`Invalid choice: ${q.question_text}`);
      }
      if (q.question_type === "email") value = email(value);
      if (
        q.question_type === "number" &&
        (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value) ||
          !Number.isFinite(Number(value)))
      )
        throw bad("Invalid number");
      if (q.question_type === "star_rating") integer(value, "rating", 1, 5);
      if (q.question_type === "rating_1_10") integer(value, "rating", 1, 10);
      if (q.question_type === "yes_no" && !["Yes", "No"].includes(value))
        throw bad("Invalid yes/no answer");
    }
    return {
      questionId: q.id,
      text: multi ? JSON.stringify([...new Set(value)]) : value,
      json: multi ? JSON.stringify([...new Set(value)]) : null,
    };
  });
}
function questionCondition(body, earlierQuestions) {
  if (!body.condition_question_id) return { condition_question_id: null, condition_value: null };
  const id = integer(body.condition_question_id, "condition question");
  const parent = earlierQuestions.find((q) => Number(q.id) === id);
  if (!parent) throw bad("Choose an earlier active question in this survey");
  if (typeof body.condition_value !== "string" || !choices(parent).includes(body.condition_value))
    throw bad("Choose a valid answer for the condition question");
  return { condition_question_id: id, condition_value: body.condition_value };
}
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
module.exports = {
  bad,
  emailHeader,
  text,
  email,
  integer,
  eventInput,
  questionInput,
  questionCondition,
  answersFor,
  csvCell,
};
