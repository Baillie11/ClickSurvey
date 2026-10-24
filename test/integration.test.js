const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const request = require("supertest");
const { migrate } = require("../scripts/migrate");
const { createApp } = require("../app");
const { deliverOne, tick } = require("../src/worker");
const { MysqlSessionStore } = require("../src/security");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { gunzipSync } = require("zlib");
const enabled = process.env.RUN_DB_TESTS === "true";
const name = "clicksurvey_test_" + crypto.randomBytes(8).toString("hex");
let db, root, app, key, clientId, surveyId, agent, token;
const config = {
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT || 33317),
  user: "root",
  password: process.env.TEST_DB_PASSWORD || "isolated-test-only",
  timezone: "Z",
  multipleStatements: true,
};
const payload = (id, extra = {}) => ({
  eventId: id,
  sourceApp: "WordPress",
  eventType: "purchase",
  recipient: { email: "test@example.com" },
  ...extra,
});
const post = (id, extra = {}) =>
  request(app)
    .post("/api/events")
    .set("Authorization", "Bearer " + key)
    .send(payload(id, extra));
function csrf(html) {
  return /name="_csrf" value="([a-f0-9]+)"/.exec(html)?.[1];
}
before(
  async () => {
    if (!enabled) return;
    process.env.BASE_URL = "http://localhost:3000";
    process.env.EMAIL_FROM = "surveys@example.com";
    root = await mysql.createConnection(config);
    await root.query(
      "CREATE DATABASE " +
        name +
        " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    );
    db = mysql.createPool({ ...config, database: name, connectionLimit: 12 });
    const c = await db.getConnection();
    try {
      await c.query(
        fs.readFileSync(path.join(__dirname, "../schema.sql"), "utf8"),
      );
      await c.execute(
        "INSERT INTO users (name,email,password_hash,created_at,updated_at) VALUES ('Legacy','legacy@example.com','old',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      );
      await c.execute(
        "INSERT INTO api_clients (client_name,api_key_hash,status,created_at,updated_at) VALUES ('Legacy','old','Active',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      );
      await migrate(c);
      await migrate(c);
      const [[legacyUser]] = await c.query(
        "SELECT is_admin FROM users WHERE email='legacy@example.com'",
      );
      assert.equal(legacyUser.is_admin, 0);
      const [[legacyKey]] = await c.query(
        "SELECT status FROM api_clients WHERE client_name='Legacy'",
      );
      assert.equal(legacyKey.status, "Disabled");
    } finally {
      c.release();
    }
    const [survey] = await db.execute(
      "INSERT INTO users (name,email,password_hash,is_admin,created_at,updated_at) VALUES ('Admin','admin@example.com',?,1,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [await bcrypt.hash("test-admin-password-unique", 4)],
    );
    const [s] = await db.execute(
      "INSERT INTO surveys (user_id,survey_key,title,status,created_at,updated_at) VALUES (?,'test','Test Survey','Active',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [survey.insertId],
    );
    surveyId = s.insertId;
    await db.execute(
      "INSERT INTO survey_questions (survey_id,question_text,question_type,required,created_at,updated_at) VALUES (?,'Rating','star_rating',1,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [surveyId],
    );
    const keyId = crypto.randomBytes(12).toString("hex");
    key = `cs_${keyId}_${crypto.randomBytes(20).toString("hex")}`;
    const [client] = await db.execute(
      "INSERT INTO api_clients (client_name,key_id,api_key_hash,allowed_surveys_json,status,created_at,updated_at) VALUES ('WordPress',?,?,?,'Active',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [keyId, await bcrypt.hash(key, 4), JSON.stringify([surveyId])],
    );
    clientId = client.insertId;
    await db.execute(
      "INSERT INTO automation_rules (rule_name,source_app,event_type,survey_id,delay_minutes,status,created_at,updated_at) VALUES ('Test','WordPress','purchase',?,60,'Active',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [surveyId],
    );
    app = createApp(db, {
      sessionSecret: "test-secret-that-is-at-least-32-characters",
    });
    agent = request.agent(app);
  },
  { timeout: 30000 },
);
after(async () => {
  if (db) await db.end();
  if (root) {
    if (/^clicksurvey_test_[a-f0-9]{16}$/.test(name))
      await root.query("DROP DATABASE " + name);
    await root.end();
  }
});
test(
  "real MySQL HTTP security, queue and concurrency",
  { skip: !enabled, timeout: 60000 },
  async (t) => {
    await t.test(
      "registration closed, CSRF enforced, persistent login and role checks",
      async () => {
        await request(app).get("/register").expect(404);
        await request(app).post("/register").send({}).expect(403);
        await request(app).get("/admin").expect(302);
        await request(app)
          .post("/login")
          .send({
            email: "admin@example.com",
            password: "test-admin-password-unique",
          })
          .expect(403);
        const page = await agent.get("/login").expect(200);
        token = csrf(page.text);
        assert.ok(token);
        await agent
          .post("/login")
          .type("form")
          .send({
            _csrf: token,
            email: "admin@example.com",
            password: "test-admin-password-unique",
          })
          .expect(302);
        const admin = await agent.get("/admin").expect(200);
        token = csrf(admin.text);
        assert.ok(token);
        await agent.get("/admin/api-clients").expect(200);
        const [[sessions]] = await db.query(
          "SELECT COUNT(*) AS n FROM sessions",
        );
        assert.ok(sessions.n > 0);
        await db.query("UPDATE users SET is_admin=0");
        await agent.get("/admin").expect(403);
        await db.query("UPDATE users SET is_admin=1");
      },
    );
    await t.test(
      "API rejects unauthenticated, malformed and cross-source requests",
      async () => {
        await request(app).post("/api/events").send(payload("bad")).expect(401);
        await post("bad", { recipient: { email: "bad" } }).expect(400);
        await post("bad", { sourceApp: "Node app" }).expect(403);
        await post("bad", { eventId: undefined }).expect(400);
        await db.execute(
          "UPDATE api_clients SET allowed_surveys_json=? WHERE id=?",
          ["[]", clientId],
        );
        await post("scope").expect(403);
        await db.execute(
          "UPDATE api_clients SET allowed_surveys_json=? WHERE id=?",
          [JSON.stringify([surveyId]), clientId],
        );
      },
    );
    await t.test(
      "concurrent retries create one invite; payload conflicts return 409; delay is honored",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 8 }, () => post("same-event")),
        );
        assert.equal(results.filter((r) => r.status === 202).length, 1);
        assert.ok(results.every((r) => [200, 202].includes(r.status)));
        const [[count]] = await db.query(
          "SELECT COUNT(*) AS n FROM survey_invites",
        );
        assert.equal(count.n, 1);
        const [[invite]] = await db.query(
          "SELECT *,TIMESTAMPDIFF(MINUTE,UTC_TIMESTAMP(),due_at) AS wait FROM survey_invites",
        );
        assert.ok(invite.wait >= 59);
        assert.equal(invite.recipient_name, null);
        assert.equal(
          await deliverOne(db, {
            sendMail() {
              throw Error("must not send early");
            },
          }),
          false,
        );
        await post("same-event", { metadata: { different: true } }).expect(409);
        const status = await request(app)
          .get("/api/events/same-event")
          .set("Authorization", "Bearer " + key)
          .expect(200);
        assert.equal(status.body.deliveryStatus, "Pending");
        await post("no-rule", { eventType: "unknown" }).expect(202);
        const retry = await post("no-rule", { eventType: "unknown" }).expect(
          200,
        );
        assert.equal(retry.body.inviteCreated, false);
      },
    );
    await t.test(
      "worker retries transient failure, delivers once across workers, escapes HTML",
      async () => {
        await db.query(
          "UPDATE survey_invites SET due_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE),recipient_name='<img src=x>'",
        );
        await deliverOne(db, {
          sendMail: async () => {
            throw Object.assign(Error("temporary"), { responseCode: 450 });
          },
        });
        const [[retry]] = await db.query(
          "SELECT status,attempts FROM survey_invites",
        );
        assert.equal(retry.status, "Retry");
        assert.equal(retry.attempts, 1);
        await db.query("UPDATE survey_invites SET due_at=UTC_TIMESTAMP()");
        let sent = 0;
        const smtp = {
          sendMail: async (mail) => {
            sent++;
            assert.ok(mail.html.includes("&lt;img"));
            assert.ok(mail.html.includes("/unsubscribe/"));
            return { accepted: ["test@example.com"], rejected: [] };
          },
        };
        await Promise.all([deliverOne(db, smtp), deliverOne(db, smtp)]);
        assert.equal(sent, 1);
        const [[invite]] = await db.query("SELECT * FROM survey_invites");
        assert.equal(invite.status, "Sent");
        await tick(db, smtp);
        await request(app).get("/ready").expect(200);
      },
    );
    await t.test(
      "single completion, answer validation, safe question archive and transactional rollback",
      async () => {
        const [[invite]] = await db.query("SELECT * FROM survey_invites");
        const [[q]] = await db.query("SELECT id FROM survey_questions");
        const respondent = request.agent(app);
        const page = await respondent
          .get("/r/" + invite.invite_token)
          .expect(200);
        const formToken = csrf(page.text);
        await respondent
          .post("/r/" + invite.invite_token)
          .type("form")
          .send({ _csrf: formToken, ["question_" + q.id]: "9" })
          .expect(400);
        await db.query(
          "CREATE TRIGGER reject_answer BEFORE INSERT ON survey_answers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected test failure'",
        );
        await respondent
          .post("/r/" + invite.invite_token)
          .type("form")
          .send({ _csrf: formToken, ["question_" + q.id]: "5" })
          .expect(500);
        const [[rolledBack]] = await db.query(
          "SELECT COUNT(*) AS n FROM survey_responses",
        );
        assert.equal(rolledBack.n, 0);
        await db.query("DROP TRIGGER reject_answer");
        const submissions = await Promise.all(
          [1, 2].map(() =>
            respondent
              .post("/r/" + invite.invite_token)
              .type("form")
              .send({ _csrf: formToken, ["question_" + q.id]: "5" }),
          ),
        );
        assert.deepEqual(submissions.map((r) => r.status).sort(), [200, 410]);
        const [[count]] = await db.query(
          "SELECT COUNT(*) AS n FROM survey_responses",
        );
        assert.equal(count.n, 1);
        await agent
          .post(`/admin/surveys/${surveyId}/questions/${q.id}/delete`)
          .type("form")
          .send({ _csrf: token })
          .expect(302);
        const [[answer]] = await db.query(
          "SELECT question_id FROM survey_answers",
        );
        assert.equal(answer.question_id, q.id);
      },
    );
    await t.test(
      "unsubscribe confirmation and suppressed delivery",
      async () => {
        const [[invite]] = await db.query("SELECT * FROM survey_invites");
        const recipient = request.agent(app);
        const page = await recipient
          .get("/unsubscribe/" + invite.invite_token)
          .expect(200);
        const [[before]] = await db.query(
          "SELECT COUNT(*) AS n FROM suppressions",
        );
        assert.equal(before.n, 0);
        await recipient
          .post("/unsubscribe/" + invite.invite_token)
          .type("form")
          .send({ _csrf: csrf(page.text) })
          .expect(200);
        await post("suppressed");
        await db.query(
          "UPDATE survey_invites SET due_at=UTC_TIMESTAMP() WHERE status='Pending'",
        );
        await deliverOne(db, {
          sendMail() {
            throw Error("must not deliver suppressed");
          },
        });
        const [[last]] = await db.query(
          "SELECT status FROM survey_invites ORDER BY id DESC LIMIT 1",
        );
        assert.equal(last.status, "Suppressed");
      },
    );
    await t.test("HTTP async failure returns generic JSON", async () => {
      const execute = db.execute.bind(db);
      db.execute = async () => {
        throw Error("sensitive connection details");
      };
      try {
        const r = await post("error").expect(500);
        assert.equal(r.body.error, "Internal server error");
        assert.ok(!r.text.includes("sensitive"));
      } finally {
        db.execute = execute;
      }
    });
    await t.test(
      "Node client sends over HTTP and a separate source gets an isolated key",
      async () => {
        const created = await agent
          .post("/admin/api-clients")
          .type("form")
          .send({
            _csrf: token,
            client_name: "Node app",
            status: "Active",
            allowed_surveys: String(surveyId),
          })
          .expect(200);
        const nodeKey = /cs_[a-f0-9]{24}_[a-f0-9]{40}/.exec(created.text)?.[0];
        assert.ok(nodeKey);
        await db.execute(
          "INSERT INTO automation_rules (rule_name,source_app,event_type,survey_id,delay_minutes,status,created_at,updated_at) VALUES ('Node','Node app','purchase',?,0,'Active',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
          [surveyId],
        );
        const server = app.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        const oldUrl = process.env.CLICKSURVEY_URL,
          oldKey = process.env.CLICKSURVEY_API_KEY;
        process.env.CLICKSURVEY_URL =
          "http://127.0.0.1:" + server.address().port;
        process.env.CLICKSURVEY_API_KEY = nodeKey;
        try {
          const { requestSurvey } = require("../examples/node-client");
          const result = await requestSurvey(
            payload("node-event", {
              sourceApp: "Node app",
              recipient: { email: "node@example.com" },
            }),
          );
          assert.equal(result.inviteCreated, true);
          const again = await requestSurvey(
            payload("node-event", {
              sourceApp: "Node app",
              recipient: { email: "node@example.com" },
            }),
          );
          assert.equal(again.duplicate, true);
        } finally {
          if (oldUrl === undefined) delete process.env.CLICKSURVEY_URL;
          else process.env.CLICKSURVEY_URL = oldUrl;
          if (oldKey === undefined) delete process.env.CLICKSURVEY_API_KEY;
          else process.env.CLICKSURVEY_API_KEY = oldKey;
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
    await t.test(
      "SMTP ambiguity, permanent failures and stale claims are recoverable without duplicate sends",
      async () => {
        await db.query(
          "UPDATE survey_invites SET due_at=UTC_TIMESTAMP() WHERE status='Pending'",
        );
        await deliverOne(db, {
          sendMail: async () => {
            throw Object.assign(Error("socket lost"), { code: "ESOCKET" });
          },
        });
        const [[ambiguous]] = await db.query(
          "SELECT status FROM survey_invites ORDER BY id DESC LIMIT 1",
        );
        assert.equal(ambiguous.status, "DeliveryUnknown");
        await db.query(
          "UPDATE survey_invites SET status='Sending',updated_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 11 MINUTE) WHERE status='DeliveryUnknown'",
        );
        await tick(db, {
          sendMail() {
            throw Error("must not retry ambiguous messages");
          },
        });
        const [[stale]] = await db.query(
          "SELECT status FROM survey_invites ORDER BY id DESC LIMIT 1",
        );
        assert.equal(stale.status, "DeliveryUnknown");
        await db.query(
          "UPDATE survey_invites SET status='Pending',due_at=UTC_TIMESTAMP() WHERE status='DeliveryUnknown'",
        );
        await deliverOne(db, {
          sendMail: async () => {
            throw Object.assign(Error("rejected"), { responseCode: 550 });
          },
        });
        const [[failed]] = await db.query(
          "SELECT id,status FROM survey_invites ORDER BY id DESC LIMIT 1",
        );
        assert.equal(failed.status, "Failed");
        await agent
          .post("/admin/delivery/" + failed.id + "/retry")
          .type("form")
          .send({ _csrf: token })
          .expect(302);
        await db.query("UPDATE surveys SET status='Archived'");
        await deliverOne(db, {
          sendMail() {
            throw Error("must not send archived survey");
          },
        });
        const [[expired]] = await db.query(
          "SELECT status FROM survey_invites ORDER BY id DESC LIMIT 1",
        );
        assert.equal(expired.status, "Expired");
        await db.query("UPDATE surveys SET status='Active'");
      },
    );
    await t.test(
      "database backup can be restored into a separate empty database",
      async () => {
        if (!process.env.TEST_MYSQLDUMP_PATH)
          return t.diagnostic(
            "Set TEST_MYSQLDUMP_PATH to include backup/restore validation",
          );
        const output = execFileSync(process.execPath, ["scripts/backup.js"], {
          cwd: path.join(__dirname, ".."),
          env: {
            ...process.env,
            DB_HOST: config.host,
            DB_PORT: String(config.port),
            DB_USER: config.user,
            DB_PASSWORD: config.password,
            DB_NAME: name,
            MYSQLDUMP_PATH: process.env.TEST_MYSQLDUMP_PATH,
          },
          encoding: "utf8",
        });
        const backupFile = output.trim().slice("Backup saved: ".length);
        const sql = gunzipSync(fs.readFileSync(backupFile)).toString("utf8");
        const restoredName = name + "_restore";
        await root.query("CREATE DATABASE " + restoredName);
        const restored = await mysql.createConnection({
          ...config,
          database: restoredName,
        });
        try {
          await restored.query(sql);
          const [[count]] = await restored.query(
            "SELECT COUNT(*) AS n FROM survey_responses",
          );
          assert.equal(count.n, 1);
        } finally {
          await restored.end();
          await root.query("DROP DATABASE " + restoredName);
          fs.unlinkSync(backupFile);
        }
      },
    );
    await t.test(
      "subdirectory Node request, email URLs, rendered form submission and guide download",
      async () => {
        const prefixed = createApp(db, {
          baseUrl: "http://localhost/clicksurvey",
          sessionSecret: "test-secret-that-is-at-least-32-characters",
        });
        const server = prefixed.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        const saved = {
          url: process.env.CLICKSURVEY_URL,
          key: process.env.CLICKSURVEY_API_KEY,
          base: process.env.BASE_URL,
        };
        process.env.CLICKSURVEY_URL =
          "http://127.0.0.1:" + server.address().port + "/clicksurvey";
        process.env.CLICKSURVEY_API_KEY = key;
        process.env.BASE_URL = process.env.CLICKSURVEY_URL;
        try {
          const { requestSurvey } = require("../examples/node-client");
          const result = await requestSurvey(
            payload("subdirectory-event", {
              recipient: { email: "prefix@example.com" },
            }),
          );
          assert.ok(result.inviteId);
          await db.execute(
            "UPDATE survey_invites SET due_at=UTC_TIMESTAMP() WHERE id=?",
            [result.inviteId],
          );
          let email;
          await deliverOne(db, {
            sendMail: async (mail) => {
              email = mail;
              return { accepted: ["prefix@example.com"], rejected: [] };
            },
          });
          assert.ok(email.text.includes("/clicksurvey/r/"));
          assert.ok(email.html.includes("/clicksurvey/unsubscribe/"));
          const [[invite]] = await db.execute(
            "SELECT invite_token FROM survey_invites WHERE id=?",
            [result.inviteId],
          );
          const { parseFragment } = require("parse5");
          function find(node, tag) {
            if (node.tagName === tag) return node;
            for (const child of node.childNodes || []) {
              const found = find(child, tag);
              if (found) return found;
            }
          }
          const respondent = request.agent(prefixed);
          const page = await respondent
            .get("/clicksurvey/r/" + invite.invite_token)
            .expect(200);
          const form = find(parseFragment(page.text), "form");
          assert.equal(
            form.attrs.find((a) => a.name === "action").value,
            "/clicksurvey/r/" + invite.invite_token,
          );
          await respondent
            .post(form.attrs.find((a) => a.name === "action").value)
            .type("form")
            .send({ _csrf: csrf(page.text) })
            .expect(200);
          const admin = request.agent(prefixed);
          const login = await admin.get("/clicksurvey/login").expect(200);
          await admin
            .post("/clicksurvey/login")
            .type("form")
            .send({
              _csrf: csrf(login.text),
              email: "admin@example.com",
              password: "test-admin-password-unique",
            })
            .expect(302)
            .expect("Location", "/clicksurvey/admin");
          await admin.get("/clicksurvey/admin/help").expect(200);
          const guide = await admin
            .get("/clicksurvey/admin/help/download")
            .expect(200);
          assert.ok(guide.text.includes("CLICK SURVEY"));
        } finally {
          for (const [key, value] of Object.entries({
            CLICKSURVEY_URL: saved.url,
            CLICKSURVEY_API_KEY: saved.key,
            BASE_URL: saved.base,
          })) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
  },
);
