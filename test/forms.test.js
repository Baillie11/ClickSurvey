const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const { parseFragment } = require("parse5");
const request = require("supertest");
const session = require("express-session");
const { createApp, validateConfig } = require("../app");
function nodes(root, tag) {
  const found = [];
  function walk(n) {
    if (n.tagName === tag) found.push(n);
    for (const child of n.childNodes || []) walk(child);
  }
  walk(root);
  return found;
}
function attr(node, key) {
  return node.attrs?.find((a) => a.name === key)?.value;
}
test("rendered forms have valid prefixed actions and a token inside each form", () => {
  const survey = {
    id: 12,
    survey_key: "feedback",
    title: "Feedback",
    description: "Intro",
    status: "Active",
    primary_colour: "#0d6efd",
  };
  const question = {
    id: 34,
    question_text: "Feedback?",
    question_type: "short_text",
    sort_order: 1,
    required: 1,
  };
  const locals = {
    appPath: "/clicksurvey",
    csrfToken: "a".repeat(64),
    title: "Test",
    error: null,
    apiKey: null,
    survey,
    question,
    questions: [question],
    choices: require("../public/question-logic").choices,
    surveys: [survey],
    clients: [{ id: 56, status: "Active", client_name: "Test" }],
    invites: [
      {
        id: 78,
        status: "Failed",
        recipient_email: "test@example.com",
        attempts: 1,
      },
    ],
    heartbeat: null,
    rules: [],
    suppressed: [],
    invite: { id: 78, invite_token: "token", source_app: "Test" },
    token: "token",
    user: { name: "Admin" },
    body: "",
  };
  const fixtures = {
    "auth/login.ejs": ["/clicksurvey/login"],
    "admin/surveys/new.ejs": ["/clicksurvey/admin/surveys"],
    "admin/surveys/edit.ejs": ["/clicksurvey/admin/surveys/12"],
    "admin/surveys/index.ejs": ["/clicksurvey/admin/surveys/12/delete"],
    "admin/surveys/questions.ejs": [
      "/clicksurvey/admin/surveys/12/questions",
      "/clicksurvey/admin/surveys/12/questions/34/delete",
    ],
    "admin/surveys/question-edit.ejs": [
      "/clicksurvey/admin/surveys/12/questions/34",
    ],
    "admin/api-clients/index.ejs": [
      "/clicksurvey/admin/api-clients",
      "/clicksurvey/admin/api-clients/56/toggle",
    ],
    "admin/automation/index.ejs": ["/clicksurvey/admin/automation"],
    "admin/suppression/index.ejs": ["/clicksurvey/admin/suppression"],
    "admin/delivery.ejs": ["/clicksurvey/admin/delivery/78/retry"],
    "public/survey.ejs": ["/clicksurvey/s/feedback"],
    "public/survey-invite.ejs": ["/clicksurvey/r/token"],
    "public/unsubscribe.ejs": ["/clicksurvey/unsubscribe/token"],
    "layout.ejs": ["/clicksurvey/logout"],
  };
  for (const [file, actions] of Object.entries(fixtures)) {
    const html = ejs.render(
      fs.readFileSync(path.join(__dirname, "../views", file), "utf8"),
      locals,
      { filename: path.join(__dirname, "../views", file) },
    );
    const tree = parseFragment(html),
      forms = nodes(tree, "form");
    assert.deepEqual(
      forms.map((f) => attr(f, "action")),
      actions,
      file,
    );
    for (const form of forms) {
      const tokens = nodes(form, "input").filter(
        (n) => attr(n, "name") === "_csrf",
      );
      assert.equal(tokens.length, 1, file);
      assert.equal(attr(tokens[0], "value"), locals.csrfToken, file);
    }
    for (const element of [...nodes(tree, "a"), ...nodes(tree, "link")]) {
      const href = attr(element, "href");
      if (href?.startsWith("/"))
        assert.ok(href.startsWith("/clicksurvey/"), file + ": " + href);
    }
  }
});
test("subdirectory HTTP routes, cookies and redirects stay under /clicksurvey", async () => {
  const app = createApp(
    { execute: async () => [[]] },
    {
      baseUrl: "http://localhost/clicksurvey",
      sessionSecret: "local-test-secret-at-least-thirty-two-characters",
      sessionStore: new session.MemoryStore(),
    },
  );
  const agent = request.agent(app);
  await agent.get("/clicksurvey/health").expect(200);
  await agent.get("/clicksurvey/styles.css").expect(200);
  const page = await agent.get("/clicksurvey/login").expect(200);
  assert.ok(page.headers["set-cookie"][0].includes("Path=/clicksurvey"));
  const form = nodes(parseFragment(page.text), "form")[0];
  const token = attr(
    nodes(form, "input").find((n) => attr(n, "name") === "_csrf"),
    "value",
  );
  await agent
    .post(attr(form, "action"))
    .type("form")
    .send({ _csrf: token, email: "admin@example.com", password: "wrong" })
    .expect(401);
  await agent
    .get("/clicksurvey/admin")
    .expect(302)
    .expect("Location", "/clicksurvey/login");
  await agent
    .post("/clicksurvey/logout")
    .type("form")
    .send({ _csrf: token })
    .expect(302)
    .expect("Location", "/clicksurvey/login");
  await agent.post("/clicksurvey/api/events").send({}).expect(401);
  await agent.get("/login").expect(404);
});
test("production config accepts a subdirectory but rejects ambiguous paths", () => {
  const saved = { ...process.env };
  try {
    process.env.SESSION_SECRET = "s".repeat(64);
    process.env.NODE_ENV = "production";
    process.env.BASE_URL = "https://clickecommerce.com.au/clicksurvey";
    validateConfig();
    for (const url of [
      "https://example.com/path?secret=value",
      "https://example.com/space%20here",
      "https://example.com/path#fragment",
    ]) {
      process.env.BASE_URL = url;
      assert.throws(validateConfig);
    }
  } finally {
    for (const k of ["SESSION_SECRET", "NODE_ENV", "BASE_URL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
