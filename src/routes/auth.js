const express = require("express");
const bcrypt = require("bcrypt");
const { rateLimit } = require("express-rate-limit");
const { email } = require("../validation");
const router = express.Router();
router.all("/register", (req, res) => res.status(404).send("Not found"));
router.get("/login", (req, res) =>
  req.session.user
    ? res.redirect("/admin")
    : res.render("auth/login", { title: "Login", error: null }),
);
router.post(
  "/login",
  rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
  async (req, res) => {
    let address;
    try {
      address = email(req.body.email);
    } catch {
      return res.status(400).render("auth/login", {
        title: "Login",
        error: "Invalid email or password.",
      });
    }
    const password = req.body.password;
    if (typeof password !== "string" || Buffer.byteLength(password) > 72)
      return res.status(400).render("auth/login", {
        title: "Login",
        error: "Invalid email or password.",
      });
    const [users] = await global.db.execute(
      "SELECT * FROM users WHERE email = ? AND is_admin = 1",
      [address],
    );
    const user = users[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).render("auth/login", {
        title: "Login",
        error: "Invalid email or password.",
      });
    await new Promise((resolve, reject) =>
      req.session.regenerate((e) => (e ? reject(e) : resolve())),
    );
    req.session.user = { id: user.id, name: user.name, email: user.email };
    await new Promise((resolve, reject) =>
      req.session.save((e) => (e ? reject(e) : resolve())),
    );
    res.redirect("/admin");
  },
);
router.post("/logout", async (req, res) => {
  await new Promise((resolve, reject) =>
    req.session.destroy((e) => (e ? reject(e) : resolve())),
  );
  res.clearCookie("clicksurvey.sid", { path: res.locals.appPath || "/" });
  res.redirect("/login");
});
module.exports = router;
