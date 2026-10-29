const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const express = require("express");
const request = require("supertest");
const { answersFor, questionCondition } = require("../src/validation");
const logic = require("../public/question-logic");
const questions = [
  { id: 1, sort_order: 1, question_type: "yes_no", question_text: "Attended?", required: 1 },
  { id: 2, sort_order: 2, question_type: "yes_no", question_text: "Enjoyed?", required: 1, condition_question_id: 1, condition_value: "Yes" },
  { id: 3, sort_order: 3, question_type: "short_text", question_text: "Why not?", required: 1, condition_question_id: 1, condition_value: "No" },
  { id: 4, sort_order: 4, question_type: "short_text", question_text: "Favourite part?", required: 1, condition_question_id: 2, condition_value: "Yes" },
];

test("Yes/No branches validate only visible answers, including nested branches", () => {
  assert.deepEqual(answersFor(questions, { question_1: "No", question_3: "Busy", question_2: "Yes", question_4: ["tampered"] }).map(a => a.questionId), [1, 3]);
  assert.deepEqual(answersFor(questions, { question_1: "Yes", question_2: "No" }).map(a => a.questionId), [1, 2]);
  assert.throws(() => answersFor(questions, { question_1: "Yes", question_2: "Yes" }), /Favourite part.*required/);
  assert.throws(() => answersFor(questions, { question_1: "Maybe" }), /Invalid yes\/no/);
  assert.deepEqual([...logic.visibleQuestions(questions, {})], ["1"]);
  assert.deepEqual([...logic.visibleQuestions([questions[2]], { question_1: "No" })], []);
});

test("checkbox branches match selected options and conditions require valid earlier choices", () => {
  const parent = { ...questions[0], question_type: "checkboxes", options_json: '["A","B"]' };
  const child = { ...questions[1], condition_value: "B" };
  assert.deepEqual([...logic.visibleQuestions([parent, child], { question_1: ["A", "B"] })], ["1", "2"]);
  assert.deepEqual([...logic.visibleQuestions([parent, child], { question_1: ["A"] })], ["1"]);
  assert.deepEqual(questionCondition({ condition_question_id: "1", condition_value: "B" }, [parent]), { condition_question_id: 1, condition_value: "B" });
  for (const body of [
    { condition_question_id: "99", condition_value: "B" },
    { condition_question_id: "1", condition_value: "Other" },
    { condition_question_id: "1", condition_value: ["B"] },
  ]) assert.throws(() => questionCondition(body, [parent]));
  assert.equal(questionCondition({}, [parent]).condition_question_id, null);
});

test("browser switching branches clears and disables hidden answers and nested children", () => {
  const controls = questions.map(() => ({ type: "select-one", value: "", disabled: false }));
  const blocks = questions.map((q, i) => ({
    dataset: { questionId: String(q.id), conditionQuestionId: q.condition_question_id ? String(q.condition_question_id) : "", conditionValue: q.condition_value || "" },
    querySelectorAll: () => [controls[i]], hidden: false,
  }));
  const listeners = {};
  const form = { querySelectorAll: () => blocks, addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/survey-logic.js"), "utf8"), {
    document: { querySelectorAll: () => [form] }, window: { addEventListener() {} }, QuestionLogic: logic,
  });
  assert.deepEqual(blocks.map(b => b.hidden), [false, true, true, true]);
  controls[0].value = "Yes";
  listeners.change();
  controls[1].value = "Yes";
  listeners.change();
  controls[3].value = "Great food";
  assert.equal(blocks[3].hidden, false);
  controls[0].value = "No";
  listeners.change();
  assert.deepEqual(blocks.map(b => b.hidden), [false, true, false, true]);
  assert.equal(controls[1].value, "");
  assert.equal(controls[3].value, "");
  assert.equal(controls[3].disabled, true);
  controls[0].value = "Yes";
  listeners.change();
  assert.equal(blocks[3].hidden, true);
});

test("admin saves conditions and rejects cross-survey, forward and broken dependencies", async () => {
  const previous = global.db;
  const writes = [];
  const db = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (sql, values) => {
      if (sql.includes("FROM surveys")) return [[{ id: 1 }]];
      if (sql.includes("FROM survey_questions")) return [questions];
      writes.push({ sql, values });
      return [{ insertId: 5 }];
    },
  };
  global.db = { getConnection: async () => db, execute: async () => [[{ id: 1 }]] };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { user: { id: 1, is_admin: 1 } }; next(); });
  app.use("/admin/surveys", require("../src/routes/surveys"));
  app.use((err, req, res, next) => res.status(err.status || 500).send(err.message));
  const base = "/admin/surveys/1/questions";
  const body = { question_text: "Follow up", question_type: "short_text", condition_question_id: "1", condition_value: "Yes" };
  try {
    await request(app).post(base).type("form").send(body).expect(302);
    assert.deepEqual(writes.at(-1).values.slice(-2), [1, "Yes"]);
    await request(app).post(base + "/3").type("form").send(body).expect(302);
    assert.deepEqual(writes.at(-1).values.slice(4, 6), [1, "Yes"]);
    await request(app).post(base).type("form").send({ ...body, condition_question_id: "99" }).expect(400);
    await request(app).post(base + "/2").type("form").send({ ...body, condition_question_id: "2" }).expect(400);
    await request(app).post(base + "/1").type("form").send({ ...body, condition_question_id: "2" }).expect(400);
    await request(app).post(base + "/1").type("form").send({ question_text: "Changed", question_type: "short_text" }).expect(400);
    await request(app).post(base + "/1/delete").type("form").send({}).expect(400);
    assert.equal(writes.length, 2);
  } finally { global.db = previous; }
});

test("public links and email invitations save only answers from the selected branch", async () => {
  const previous = global.db;
  const writes = [];
  const survey = { id: 1, title: "Survey", status: "Active" };
  const invite = { id: 7, survey_id: 1, survey_status: "Active", status: "Sent", expires_at: new Date(Date.now() + 60000) };
  const db = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (sql, values) => {
      if (sql.includes("FROM survey_questions")) return [questions];
      if (sql.includes("FROM survey_invites")) return [[invite]];
      if (sql.includes("FROM surveys")) return [[survey]];
      if (sql.startsWith("INSERT INTO survey_answers")) writes.push(values);
      return [{ insertId: 20 }];
    },
  };
  global.db = { getConnection: async () => db };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { res.render = () => res.send("Thank you"); next(); });
  app.use(require("../src/routes/public"));
  app.use((err, req, res, next) => res.status(err.status || 500).send(err.message));
  try {
    for (const url of ["/s/test", "/r/token"]) {
      writes.length = 0;
      await request(app).post(url).type("form").send({ question_1: "No", question_3: "Busy", question_2: "Yes", question_4: "Ignore me" }).expect(200);
      assert.deepEqual(writes.map(v => v[1]), [1, 3]);
      await request(app).post(url).type("form").send({ question_1: "Yes" }).expect(400);
    }
  } finally { global.db = previous; }
});

test("branching migration upgrades existing databases once and remains repeatable", async () => {
  const { migrate } = require("../scripts/migrate");
  const versions = new Set(["001-hardening", "002-survey-email"]);
  const columns = new Set();
  let changes = 0;
  const db = {
    query: async (sql) => {
      if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.startsWith("SELECT version")) return [versions.has(sql.match(/version = '([^']+)'/)[1]) ? [{}] : []];
      if (sql.startsWith("ALTER TABLE")) { columns.add(sql.split(" ")[5]); changes++; }
      if (sql.startsWith("INSERT INTO schema_migrations")) versions.add(sql.match(/VALUES \('([^']+)'/)[1]);
      return [[]];
    },
    execute: async (sql, values) => [columns.has(values[1]) ? [{}] : []],
  };
  await migrate(db);
  await migrate(db);
  assert.deepEqual([...columns], ["condition_question_id", "condition_value"]);
  assert.equal(changes, 2);
  assert.ok(versions.has("003-question-logic"));
});

test("migration repairs legacy internal MyISAM tables before checking transactional safety", async () => {
  const { migrate } = require("../scripts/migrate");
  const legacy = new Set(["sessions", "worker_state", "schema_migrations"]);
  const converted = [];
  const db = {
    query: async (sql) => {
      if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.includes("information_schema.tables")) return [[...legacy].map(table_name => ({ table_name }))];
      if (sql.startsWith("ALTER TABLE")) {
        const name = sql.split(" ")[2];
        assert.ok(legacy.has(name));
        assert.ok(sql.endsWith("ENGINE=InnoDB"));
        legacy.delete(name);
        converted.push(name);
      }
      if (sql.startsWith("SELECT version")) return [[{ version: "applied" }]];
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS") && !sql.includes("users"))
        assert.ok(sql.endsWith("ENGINE=InnoDB"));
      return [[]];
    },
  };
  await migrate(db);
  await migrate(db);
  assert.deepEqual(converted.sort(), ["schema_migrations", "sessions", "worker_state"]);
});
