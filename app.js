require("dotenv").config();
const express = require("express");
const session = require("express-session");
const layouts = require("express-ejs-layouts");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const { initDb } = require("./src/models/db");
const { MysqlSessionStore, csrf } = require("./src/security");

function validateConfig() {
  if (
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32 ||
    /^(secret|your-session-secret)$/.test(process.env.SESSION_SECRET)
  )
    throw new Error(
      "SESSION_SECRET must be a unique secret of at least 32 characters",
    );
  const url = new URL(process.env.BASE_URL || "http://localhost:3000");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("Production BASE_URL must use HTTPS");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid BASE_URL");
  if (
    !/^(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(
      "BASE_URL may have a simple installation path, without a query or fragment",
    );
  if (
    process.env.TRUST_PROXY_HOPS &&
    !/^[1-9]\d?$/.test(process.env.TRUST_PROXY_HOPS)
  )
    throw new Error("TRUST_PROXY_HOPS must be an explicit positive hop count");
  if (
    !/^\d+$/.test(process.env.PORT || "3000") ||
    Number(process.env.PORT || 3000) < 1 ||
    Number(process.env.PORT || 3000) > 65535
  )
    throw new Error("Invalid PORT");
}
function createApp(db, options = {}) {
  global.db = db;
  const app = express();
  const baseUrl = (
    options.baseUrl ||
    process.env.BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const appPath = new URL(baseUrl).pathname.replace(/\/$/, "");
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.locals.appPath = appPath;
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      const index = args.length - 1;
      const target = args[index];
      if (
        typeof target === "string" &&
        target.startsWith("/") &&
        !target.startsWith("//")
      )
        args[index] = appPath + target;
      return redirect(...args);
    };
    next();
  });
  if (process.env.TRUST_PROXY_HOPS)
    app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'", "https://cdn.jsdelivr.net"],
          "style-src": [
            "'self'",
            "'unsafe-inline'",
            "https://cdn.jsdelivr.net",
          ],
          "img-src": ["'self'", "https:", "data:"],
          "upgrade-insecure-requests":
            process.env.NODE_ENV === "production" ? [] : null,
        },
      },
    }),
  );
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (req, res) => {
    try {
      const [[worker]] = await db.query(
        "SELECT heartbeat_at > DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 MINUTE) AS healthy FROM worker_state WHERE id=1",
      );
      res
        .status(worker?.healthy ? 200 : 503)
        .json({ status: worker?.healthy ? "ready" : "worker_unavailable" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use(express.static(path.join(__dirname, "public")));
  app.use(
    express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 500 }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    require("./src/routes/api"),
  );
  app.use(
    session({
      name: "clicksurvey.sid",
      secret: options.sessionSecret || process.env.SESSION_SECRET,
      store: options.sessionStore || new MysqlSessionStore(db),
      resave: false,
      saveUninitialized: false,
      cookie: {
        path: appPath || "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 86400000,
      },
    }),
  );
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.locals.user = req.session.user;
    res.locals.baseUrl = baseUrl;
    next();
  });
  app.use(csrf);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.use(layouts);
  app.set("layout", "layout");
  app.use("/", require("./src/routes/auth"));
  app.use("/admin", require("./src/routes/admin"));
  app.use("/admin/surveys", require("./src/routes/surveys"));
  app.use(
    "/",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    require("./src/routes/public"),
  );
  app.use((req, res) => res.status(404).render("404", { title: "Not found" }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
      error.status >= 400 && error.status < 500
        ? error.status
        : error.code === "ER_DUP_ENTRY"
          ? 409
          : 500;
    if (status === 500)
      console.error("Request failed:", error.code || error.name);
    const message =
      status === 500
        ? "Internal server error"
        : status === 409
          ? "Record already exists"
          : error.type === "entity.parse.failed"
            ? "Invalid JSON"
            : error.message;
    if (req.path.startsWith("/api"))
      return res.status(status).json({ success: false, error: message });
    res.status(status).type("text").send(message);
  });
  if (!appPath) return app;
  const host = express();
  host.disable("x-powered-by");
  if (process.env.TRUST_PROXY_HOPS)
    host.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS));
  host.use(appPath, app);
  return host;
}
async function start() {
  validateConfig();
  const db = await initDb();
  const app = createApp(db);
  const server = app.listen(Number(process.env.PORT || 3000), () =>
    console.log("ClickSurvey started"),
  );
  server.on("error", (error) => {
    console.error("Server startup failed:", error.code);
    process.exitCode = 1;
    db.end();
  });
  const stop = () => server.close(() => db.end().then(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
if (require.main === module)
  start().catch((error) => {
    console.error("Startup failed:", error.message);
    process.exitCode = 1;
  });
module.exports = { createApp, validateConfig };
