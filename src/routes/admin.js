const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../security");
const {
  text,
  emailHeader,
  email: validEmail,
  integer,
  bad,
  csvCell,
} = require("../validation");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

router.use(requireAdmin);
router.use((req, res, next) => {
  if (req.method === "POST") {
    const b = (req.body ||= {});
    if (/^\/surveys(?:\/\d+)?$/.test(req.path)) {
      b.survey_key = text(b.survey_key, "survey key", 100);
      if (!/^[a-zA-Z0-9_-]+$/.test(b.survey_key))
        throw bad(
          "Survey key must use letters, numbers, hyphens or underscores",
        );
      b.title = text(b.title, "title");
      if (!["Active", "Draft", "Archived"].includes(b.status))
        throw bad("Invalid survey status");
      for (const k of ["description", "thank_you_message"])
        b[k] = text(b[k], k, 10000, true);
      for (const k of ["brand_name", "logo_url", "footer_text"])
        b[k] = text(b[k], k, 255, true);
      for (const k of ["email_subject", "email_sender_name"])
        b[k] = emailHeader(b[k], k);
      if (b.logo_url) {
        let url;
        try {
          url = new URL(b.logo_url);
        } catch {
          throw bad("Invalid logo URL");
        }
        if (url.protocol !== "https:") throw bad("Logo URL must use HTTPS");
      }
      b.primary_colour = b.primary_colour || "#0d6efd";
      if (!/^#[a-f0-9]{6}$/i.test(b.primary_colour))
        throw bad("Invalid brand colour");
    }
    if (req.path === "/automation") {
      for (const k of ["rule_name", "source_app", "event_type"])
        b[k] = text(b[k], k);
      b.survey_id = integer(b.survey_id, "survey");
      b.delay_minutes = integer(b.delay_minutes || 0, "delay", 0, 43200);
      if (!["Active", "Inactive"].includes(b.status))
        throw bad("Invalid rule status");
    }
    if (req.path === "/api-clients") {
      b.client_name = text(b.client_name, "client name");
      if (!["Active", "Disabled"].includes(b.status))
        throw bad("Invalid client status");
    }
    if (req.path === "/suppression") {
      b.email = validEmail(b.email);
      b.reason = text(b.reason, "reason", 255, true);
      b.source_app = text(b.source_app, "source app", 255, true);
    }
  }
  next();
});
router.param("id", (req, res, next, value) => {
  integer(value, "record ID");
  next();
});

router.get("/help", (req, res) => {
  res.render("admin/help", {
    title: "Help & Tutorial",
    guide: fs.readFileSync(
      path.join(__dirname, "../../USER-GUIDE.txt"),
      "utf8",
    ),
  });
});
router.get("/help/download", (req, res) =>
  res.download(
    path.join(__dirname, "../../USER-GUIDE.txt"),
    "ClickSurvey-User-Guide.txt",
  ),
);

router.get("/", async (req, res) => {
  const [surveyCountRows] = await global.db.execute(
    "SELECT COUNT(*) as count FROM surveys",
  );
  const [activeCountRows] = await global.db.execute(
    "SELECT COUNT(*) as count FROM surveys WHERE status = 'Active'",
  );
  const [responseCountRows] = await global.db.execute(
    "SELECT COUNT(*) as count FROM survey_responses",
  );
  const [inviteCountRows] = await global.db.execute(
    "SELECT COUNT(*) as count FROM survey_invites WHERE status NOT IN ('Pending', 'Failed', 'Suppressed')",
  );
  const [recentResponses] = await global.db.execute(
    "SELECT sr.id, s.title, sr.submitted_at, si.recipient_name, si.recipient_email FROM survey_responses sr LEFT JOIN surveys s ON sr.survey_id = s.id LEFT JOIN survey_invites si ON sr.invite_id = si.id ORDER BY sr.submitted_at DESC LIMIT 5",
  );
  const [recentEvents] = await global.db.execute(
    "SELECT source_app, event_type, recipient_email, received_at FROM events ORDER BY received_at DESC LIMIT 5",
  );
  const [recentInvites] = await global.db.execute(
    "SELECT si.id, s.title, si.recipient_email, si.status, si.sent_at FROM survey_invites si LEFT JOIN surveys s ON si.survey_id = s.id ORDER BY si.created_at DESC LIMIT 5",
  );

  res.render("admin/dashboard", {
    title: "Dashboard",
    stats: {
      surveyCount: surveyCountRows[0].count,
      activeCount: activeCountRows[0].count,
      responseCount: responseCountRows[0].count,
      inviteCount: inviteCountRows[0].count,
    },
    recentResponses,
    recentEvents,
    recentInvites,
  });
});

router.get("/surveys", async (req, res) => {
  const status = req.query.status === "Active" ? "Active" : "";
  const [surveys] = await global.db.execute(
    status ? "SELECT * FROM surveys WHERE status = ? ORDER BY updated_at DESC" : "SELECT * FROM surveys ORDER BY updated_at DESC",
    status ? [status] : [],
  );
  res.render("admin/surveys/index", { title: "Surveys", surveys, status });
});

router.get("/surveys/:id/preview", async (req, res) => {
  const [rows] = await global.db.execute("SELECT * FROM surveys WHERE id = ?", [req.params.id]);
  if (!rows.length) throw bad("Survey not found", 404);
  const [questions] = await global.db.execute(
    "SELECT * FROM survey_questions WHERE survey_id = ? AND archived = 0 ORDER BY sort_order,id",
    [req.params.id],
  );
  res.render("public/survey", { title: "Survey preview", survey: rows[0], questions, error: null, preview: true });
});

router.get("/surveys/new", (req, res) => {
  res.render("admin/surveys/new", {
    title: "New Survey",
    survey: {},
    error: null,
  });
});

router.post("/surveys", async (req, res) => {
  const {
    survey_key,
    title,
    description,
    thank_you_message,
    status,
    brand_name,
    logo_url,
    primary_colour,
    footer_text,
    email_subject,
    email_sender_name,
  } = req.body;
  if (!survey_key || !title) {
    return res.render("admin/surveys/new", {
      title: "New Survey",
      survey: req.body,
      error: "Survey key and title are required.",
    });
  }
  const [existing] = await global.db.execute(
    "SELECT id FROM surveys WHERE survey_key = ?",
    [survey_key],
  );
  if (existing.length) {
    return res.render("admin/surveys/new", {
      title: "New Survey",
      survey: req.body,
      error: "Survey key already exists.",
    });
  }
  await global.db.execute(
    "INSERT INTO surveys (user_id, survey_key, title, description, thank_you_message, status, brand_name, logo_url, primary_colour, footer_text, email_subject, email_sender_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [
      req.session.user.id,
      survey_key,
      title,
      description,
      thank_you_message,
      status || "Draft",
      brand_name,
      logo_url,
      primary_colour,
      footer_text,
      email_subject,
      email_sender_name,
    ],
  );
  res.redirect("/admin/surveys");
});

router.get("/surveys/:id/edit", async (req, res) => {
  const [rows] = await global.db.execute("SELECT * FROM surveys WHERE id = ?", [
    req.params.id,
  ]);
  const survey = rows[0];
  if (!survey) return res.redirect("/admin/surveys");
  res.render("admin/surveys/edit", {
    title: "Edit Survey",
    survey,
    error: null,
  });
});

router.post("/surveys/:id", async (req, res) => {
  const {
    survey_key,
    title,
    description,
    thank_you_message,
    status,
    brand_name,
    logo_url,
    primary_colour,
    footer_text,
    email_subject,
    email_sender_name,
  } = req.body;
  await global.db.execute(
    "UPDATE surveys SET survey_key = ?, title = ?, description = ?, thank_you_message = ?, status = ?, brand_name = ?, logo_url = ?, primary_colour = ?, footer_text = ?, email_subject = ?, email_sender_name = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
    [
      survey_key,
      title,
      description,
      thank_you_message,
      status || "Draft",
      brand_name,
      logo_url,
      primary_colour,
      footer_text,
      email_subject,
      email_sender_name,
      req.params.id,
    ],
  );
  res.redirect("/admin/surveys");
});

router.post("/surveys/:id/delete", async (req, res) => {
  await global.db.execute("UPDATE surveys SET status = ? WHERE id = ?", [
    "Archived",
    req.params.id,
  ]);
  res.redirect("/admin/surveys");
});

router.get("/automation", async (req, res) => {
  const [rules] = await global.db.execute(
    "SELECT ar.*, s.title as survey_title FROM automation_rules ar LEFT JOIN surveys s ON ar.survey_id = s.id ORDER BY ar.updated_at DESC",
  );
  const [surveys] = await global.db.execute(
    'SELECT id, title FROM surveys WHERE status = "Active"',
  );
  res.render("admin/automation/index", {
    title: "Automation Rules",
    rules,
    surveys,
    error: null,
  });
});

router.post("/automation", async (req, res) => {
  const {
    rule_name,
    source_app,
    event_type,
    survey_id,
    delay_minutes,
    status,
  } = req.body;
  const [activeSurveys] = await global.db.execute(
    "SELECT id FROM surveys WHERE id=? AND status='Active'",
    [survey_id],
  );
  if (!activeSurveys.length) throw bad("Choose an active survey");
  if (!rule_name || !source_app || !event_type || !survey_id) {
    const [rules] = await global.db.execute(
      "SELECT ar.*, s.title as survey_title FROM automation_rules ar LEFT JOIN surveys s ON ar.survey_id = s.id ORDER BY ar.updated_at DESC",
    );
    const [surveys] = await global.db.execute(
      'SELECT id, title FROM surveys WHERE status = "Active"',
    );
    return res.render("admin/automation/index", {
      title: "Automation Rules",
      rules,
      surveys,
      error: "All fields are required.",
    });
  }
  await global.db.execute(
    "INSERT INTO automation_rules (rule_name, source_app, event_type, survey_id, delay_minutes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [
      rule_name,
      source_app,
      event_type,
      survey_id,
      delay_minutes || 0,
      status || "Active",
    ],
  );
  res.redirect("/admin/automation");
});

router.get("/api-clients", async (req, res) => {
  const [clients] = await global.db.execute(
    "SELECT id, client_name, status, created_at FROM api_clients ORDER BY created_at DESC",
  );
  res.render("admin/api-clients/index", {
    title: "API Clients",
    clients,
    error: null,
    apiKey: null,
  });
});

router.post("/api-clients", async (req, res) => {
  const { client_name, status } = req.body;
  if (!client_name) {
    const [clients] = await global.db.execute(
      "SELECT id, client_name, status, created_at FROM api_clients ORDER BY created_at DESC",
    );
    return res.render("admin/api-clients/index", {
      title: "API Clients",
      clients,
      error: "Client name is required.",
      apiKey: null,
    });
  }
  const allowed = [
    ...new Set(
      String(req.body.allowed_surveys || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => integer(x, "allowed survey ID")),
    ),
  ];
  if (!allowed.length) throw bad("Provide at least one allowed survey ID");
  for (const id of allowed) {
    const [surveys] = await global.db.execute(
      "SELECT id FROM surveys WHERE id=?",
      [id],
    );
    if (!surveys.length) throw bad("Allowed survey does not exist");
  }
  const keyId = crypto.randomBytes(12).toString("hex");
  const rawKey = `cs_${keyId}_${crypto.randomBytes(20).toString("hex")}`;
  const hashedKey = await require("bcrypt").hash(rawKey, 12);
  await global.db.execute(
    "INSERT INTO api_clients (client_name, key_id, api_key_hash, status, allowed_surveys_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [
      client_name,
      keyId,
      hashedKey,
      status || "Active",
      JSON.stringify(allowed),
    ],
  );
  const [clients] = await global.db.execute(
    "SELECT id, client_name, status, created_at FROM api_clients ORDER BY created_at DESC",
  );
  res.render("admin/api-clients/index", {
    title: "API Clients",
    clients,
    error: null,
    apiKey: rawKey,
  });
});

router.post("/api-clients/:id/toggle", async (req, res) => {
  const [rows] = await global.db.execute(
    "SELECT status FROM api_clients WHERE id = ?",
    [req.params.id],
  );
  if (!rows.length) return res.redirect("/admin/api-clients");
  const status = rows[0].status === "Active" ? "Disabled" : "Active";
  await global.db.execute(
    "UPDATE api_clients SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
    [status, req.params.id],
  );
  res.redirect("/admin/api-clients");
});

router.get("/suppression", async (req, res) => {
  const [suppressed] = await global.db.execute(
    "SELECT * FROM suppressions ORDER BY created_at DESC",
  );
  res.render("admin/suppression/index", {
    title: "Suppression List",
    suppressed,
    error: null,
  });
});

router.post("/suppression", async (req, res) => {
  const { email, reason, source_app } = req.body;
  if (!email) {
    const [suppressed] = await global.db.execute(
      "SELECT * FROM suppressions ORDER BY created_at DESC",
    );
    return res.render("admin/suppression/index", {
      title: "Suppression List",
      suppressed,
      error: "Email is required.",
    });
  }
  await global.db.execute(
    "INSERT INTO suppressions (email, reason, source_app, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())",
    [email, reason, source_app],
  );
  res.redirect("/admin/suppression");
});

router.get("/responses", async (req, res) => {
  const [responses] = await global.db.execute(
    "SELECT sr.id, s.title as survey_title, sr.submitted_at, si.recipient_name, si.recipient_email, si.source_app, si.event_type FROM survey_responses sr LEFT JOIN surveys s ON sr.survey_id = s.id LEFT JOIN survey_invites si ON sr.invite_id = si.id ORDER BY sr.submitted_at DESC",
  );
  res.render("admin/responses/index", { title: "Responses", responses });
});

router.get("/responses/:id", async (req, res) => {
  const [rows] = await global.db.execute(
    "SELECT sr.*, s.title as survey_title, si.recipient_name, si.recipient_email, si.source_app, si.event_type, si.metadata_json FROM survey_responses sr LEFT JOIN surveys s ON sr.survey_id = s.id LEFT JOIN survey_invites si ON sr.invite_id = si.id WHERE sr.id = ?",
    [req.params.id],
  );
  const response = rows[0];
  if (!response) return res.redirect("/admin/responses");
  const [answers] = await global.db.execute(
    "SELECT sq.question_text, sq.question_type, sa.answer_text, sa.answer_json FROM survey_answers sa LEFT JOIN survey_questions sq ON sa.question_id = sq.id WHERE sa.response_id = ? ORDER BY sq.sort_order ASC",
    [response.id],
  );
  res.render("admin/responses/view", {
    title: "Response Detail",
    response,
    answers,
  });
});

router.get("/surveys/:id/responses/csv", async (req, res) => {
  const [surveyRows] = await global.db.execute(
    "SELECT * FROM surveys WHERE id = ?",
    [req.params.id],
  );
  if (!surveyRows.length) return res.redirect("/admin/surveys");
  const survey = surveyRows[0];
  const [questions] = await global.db.execute(
    "SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order ASC",
    [survey.id],
  );
  const [responses] = await global.db.execute(
    "SELECT sr.*, si.recipient_name, si.recipient_email, si.source_app, si.event_type, si.metadata_json FROM survey_responses sr LEFT JOIN survey_invites si ON sr.invite_id = si.id WHERE sr.survey_id = ? ORDER BY sr.submitted_at ASC",
    [survey.id],
  );
  const header = [
    "Response ID",
    "Submitted At",
    "Recipient Name",
    "Recipient Email",
    "Source App",
    "Event Type",
    "Metadata",
    ...questions.map((q) => q.question_text),
  ];
  const rows = [];
  for (const response of responses) {
    const [answers] = await global.db.execute(
      "SELECT sa.question_id, sa.answer_text FROM survey_answers sa WHERE sa.response_id = ?",
      [response.id],
    );
    const answerMap = answers.reduce((map, item) => {
      map[item.question_id] = item.answer_text;
      return map;
    }, {});
    rows.push([
      response.id,
      response.submitted_at,
      response.recipient_name,
      response.recipient_email,
      response.source_app,
      response.event_type,
      response.metadata_json,
      ...questions.map((q) => answerMap[q.id] || ""),
    ]);
  }
  const csv = [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="survey-${survey.id}-responses.csv"`,
  );
  res.send(csv);
});

router.get("/delivery", async (req, res) => {
  const [invites] = await global.db.query(
    "SELECT id,recipient_email,status,attempts,due_at,last_error FROM survey_invites ORDER BY id DESC LIMIT 200",
  );
  const [workers] = await global.db.query(
    "SELECT heartbeat_at FROM worker_state WHERE id=1",
  );
  res.render("admin/delivery", {
    title: "Invitation delivery",
    invites,
    heartbeat: workers[0]?.heartbeat_at,
  });
});
router.post("/delivery/:id/retry", async (req, res) => {
  const id = integer(req.params.id, "invite");
  await global.db.execute(
    "UPDATE survey_invites SET status='Retry',attempts=0,due_at=UTC_TIMESTAMP(),last_error=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND status='Failed' AND expires_at>UTC_TIMESTAMP()",
    [id],
  );
  res.redirect("/admin/delivery");
});
module.exports = router;
