const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  eventInput,
  answersFor,
  questionInput,
  csvCell,
} = require("../src/validation");
const { canonical } = require("../src/routes/api");
const { escapeHtml } = require("../src/worker");
test("event validation normalizes email-only recipients and rejects malformed payloads", () => {
  const event = {
    eventId: "order-123",
    sourceApp: "WordPress",
    eventType: "purchase",
    recipient: { email: "TEST@example.com" },
  };
  assert.deepEqual(eventInput(event).recipient, {
    name: null,
    email: "test@example.com",
  });
  for (const b of [
    null,
    [],
    { ...event, eventId: undefined },
    { ...event, recipient: { email: "bad" } },
    { ...event, metadata: [] },
  ])
    assert.throws(() => eventInput(b));
  assert.throws(() => eventInput(event, "different"));
  assert.equal(
    canonical({ b: 2, a: { d: 4, c: 3 } }),
    canonical({ a: { c: 3, d: 4 }, b: 2 }),
  );
});
test("survey answer constraints are enforced on the server", () => {
  const q = (question_type, required = 1) => [
    {
      id: 1,
      question_type,
      question_text: "Answer",
      required,
      options_json: '["A","B"]',
    },
  ];
  for (const [type, value] of [
    ["short_text", "  "],
    ["email", "bad"],
    ["number", "Infinity"],
    ["star_rating", "6"],
    ["rating_1_10", "11"],
    ["yes_no", "Maybe"],
    ["dropdown", "C"],
    ["checkboxes", ["A", "C"]],
  ])
    assert.throws(() => answersFor(q(type), { question_1: value }));
  assert.equal(answersFor(q("number"), { question_1: "0" })[0].text, "0");
  assert.equal(answersFor(q("checkboxes", 0), {})[0].json, "[]");
  assert.equal(
    answersFor(q("checkboxes"), { question_1: ["A", "A"] })[0].json,
    '["A"]',
  );
  assert.throws(() =>
    questionInput({
      question_text: "Q",
      question_type: "dropdown",
      options_json: "oops",
    }),
  );
});
test("CSV formula neutralization and email HTML escaping", () => {
  for (const value of ["=1+1", " +CMD", "@SUM(1)", "\tformula", "-1"])
    assert.ok(csvCell(value).startsWith("\"'"));
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(escapeHtml("<img src=x>"), "&lt;img src=x&gt;");
});
