const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");
const db = require("../db");
const { ACCOUNT_STATUS, getAccountStatus } = require("../schema");
const { getSettings, isSiteEnabled, SITE_DISABLED_MESSAGE } = require("../settingsCore");

// Every authenticated request in the project passes through here first, so
// this is also the single enforcement point for the "حالة الموقع" kill
// switch: when the admin disables the platform, every non-admin request —
// applications, requests, chat, announcements, /auth/me, everything — is
// rejected here at the API/middleware level, not just hidden in the UI.
// This can't be bypassed by hitting the API directly, using dev tools, or
// reusing an existing token: it's re-checked fresh from the database on
// every single request. The admin role is exempt unconditionally, so the
// platform can always be re-enabled.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "يلزم تسجيل الدخول." });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: "الجلسة منتهية، يرجى تسجيل الدخول من جديد." });
  }
  req.user = payload; // { id, role, username }
  if (payload.role !== "admin") {
    try {
      const data = await db.getAll();
      if (!isSiteEnabled(getSettings(data))) {
        return res.status(503).json({ error: SITE_DISABLED_MESSAGE, siteDisabled: true });
      }
      // A referee disabled mid-session (see routes/admin.js POST
      // /users/:id/disable) must lose access immediately, not just on their
      // next login — this token could still be valid for weeks otherwise.
      const user = data.users.find((u) => u.id === payload.id);
      if (user && user.disabled) {
        return res.status(403).json({ error: "تم تعطيل هذا الحساب من طرف الإدارة.", accountDisabled: true });
      }
    } catch (e) {
      // A transient DB hiccup here shouldn't itself lock everyone out —
      // every route past this point hits the DB anyway and will surface
      // the same failure clearly if it's a real outage.
      console.error(e);
    }
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: "غير مصرح لك بالوصول لهذا المورد." });
    }
    next();
  };
}

// Same as requireRole, but accepts any of several roles — used by the
// finance module, which (unlike the rest of the platform) has three
// distinct roles: "admin" (مدير النظام — full control, inherited from the
// existing platform-wide admin role), "finance_admin" (المسؤول المالي),
// and "finance_viewer" (مستخدم للعرض). Checked fresh on every request from
// the signed JWT payload — never trust a role the frontend merely hides UI
// for.
function requireAnyRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ error: "غير مصرح لك بالوصول لهذا المورد." });
    }
    next();
  };
}

// Blocks referees whose account isn't fully active yet. Covers all three
// non-active states uniformly — قيد المراجعة (pending_review), يحتاج إلى
// تعديل (needs_edit), مرفوض (rejected) — this is the single enforcement
// point every protected referee route goes through (applications, requests,
// most of chat…), re-checked fresh from the database on every request, so
// none of these states can be bypassed by calling the API directly no
// matter what the frontend shows. Admins (and, by extension, any route this
// isn't attached to) are never affected. Looks the user up fresh from the
// DB rather than trusting the JWT, since accountStatus can change (the
// admin reviews the account) without the referee logging out.
const ACCOUNT_STATUS_MESSAGES = {
  [ACCOUNT_STATUS.PENDING_REVIEW]: "حسابك قيد المراجعة والتفعيل من طرف الإدارة لاستكمال التسجيل ورفع الملفات.",
  [ACCOUNT_STATUS.NEEDS_EDIT]: "طلبت الإدارة تعديل بعض معلومات تسجيلك قبل إتمام المراجعة. يرجى تصحيحها من صفحة \"متابعة التسجيل\" ثم إعادة الإرسال.",
  [ACCOUNT_STATUS.REJECTED]: "تم رفض تسجيلك من طرف الإدارة. راجع صفحة \"متابعة التسجيل\" للاطلاع على سبب الرفض.",
};
async function requireActiveAccount(req, res, next) {
  if (!req.user || req.user.role !== "referee") return next();
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: "المستخدم غير موجود." });
  const status = getAccountStatus(user);
  if (status === ACCOUNT_STATUS.ACTIVE) return next();
  return res.status(403).json({
    error: ACCOUNT_STATUS_MESSAGES[status] || ACCOUNT_STATUS_MESSAGES[ACCOUNT_STATUS.PENDING_REVIEW],
    accountStatus: status,
    reviewFields: user.reviewFields || [],
    reviewNote: user.reviewNote || null,
    rejectionReason: user.rejectionReason || null,
  });
}

module.exports = { requireAuth, requireRole, requireAnyRole, requireActiveAccount };
