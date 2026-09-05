// routes/auth.js — minimal auth for the finance-system project.
//
// This is intentionally a small subset of the referee-platform's own
// routes/auth.js: the finance system has no signup/registration flow of
// its own (finance_admin/finance_viewer accounts are created by an admin
// from inside the finance UI — see routes/finance.js POST /users), so all
// that's needed here is: log in, fetch "my" account, and change my own
// password. All three work against the SAME shared users table as the
// referee-platform project (see the note at the top of db.js), so an
// existing admin account (created by the referee-platform's seedAdmin())
// logs in here with the exact same username/password.
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { JWT_SECRET } = require("../config");
const { requireAuth } = require("../middleware/auth");
const { getSettings, isSiteEnabled, SITE_DISABLED_MESSAGE } = require("../settingsCore");

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

function publicUser(u) {
  return {
    id: u.id, role: u.role, username: u.username, fullNameAr: u.fullNameAr,
    status: u.status || "active",
  };
}

function normUsername(v) { return String(v || "").trim().toLowerCase(); }
function normEmail(v) { return String(v || "").trim().toLowerCase(); }

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "أدخل اسم المستخدم وكلمة المرور." });
    const data = await db.getAll();
    const user = data.users.find((u) => normUsername(u.username) === normUsername(username) || normEmail(u.email) === normUsername(username));
    if (!user) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });

    // Only admin / finance_admin / finance_viewer may use the finance
    // system at all — a referee account with a perfectly valid password
    // still can't log in here (enforced again on every request by
    // requireAnyRole in the finance routes, this is just a friendlier
    // error at the login step itself).
    if (!["admin", "finance_admin", "finance_viewer"].includes(user.role)) {
      return res.status(403).json({ error: "هذا الحساب غير مخوّل بالدخول إلى النظام المالي." });
    }

    // Whole-platform kill switch (shared "settings" — see settingsCore.js):
    // the admin account is always exempt; every other account is blocked
    // while the referee platform is disabled, same rule as before the
    // split.
    if (user.role !== "admin" && !isSiteEnabled(getSettings(data))) {
      return res.status(503).json({ error: SITE_DISABLED_MESSAGE, siteDisabled: true });
    }
    if (user.disabled) {
      return res.status(403).json({ error: "تم تعطيل هذا الحساب من طرف الإدارة.", accountDisabled: true });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
  res.json({ user: publicUser(user) });
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "أدخل كلمة السر الحالية والجديدة." });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: "كلمة السر الجديدة قصيرة جدًا." });
    }
    const data = await db.getAll();
    const user = data.users.find((u) => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: "كلمة السر الحالية غير صحيحة." });
    user.password = await bcrypt.hash(newPassword, 10);
    await db.saveAll(data);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

module.exports = router;
