// schema.js — single source of truth for the application form fields and
// required documents. Shared conceptually between server validation and the
// frontend (the frontend keeps its own copy in sync, see public/app.js).

const SEASON = "2026/2027";

// ---- Referee account activation review (separate from the application/
// file approval pipeline further below). A new signup is NOT activated
// immediately: it starts "قيد المراجعة" (pending_review) and the admin must
// review it before the referee can do anything beyond messaging the admin
// directly. From there the admin has exactly three outcomes:
//   🟢 accept   -> "active"      (referee proceeds to the enrollment form)
//   🔵 needs edit -> "needs_edit" (admin names the field(s) + a note; the
//                    referee corrects them and resubmits — same account,
//                    same registration record, never a duplicate)
//   🔴 reject   -> "rejected"    (admin must give a reason; registration
//                    stops)
// From "needs_edit", resubmitting always returns the account to
// "pending_review" so the admin re-reviews it — this loop can repeat as
// many times as needed. Existing accounts created before this system
// existed have no accountStatus at all — getAccountStatus() treats that
// (and any unrecognized value) as "active" so nobody already using the
// platform gets locked out retroactively. The PENDING_REVIEW value is
// deliberately still the string "pending" (not "pending_review") — that is
// the original value this field has always held, kept unchanged so every
// already-stored account and every existing frontend check
// (`accountStatus === "pending"`) keeps working without a data migration.
const ACCOUNT_STATUS = { PENDING_REVIEW: "pending", NEEDS_EDIT: "needs_edit", ACTIVE: "active", REJECTED: "rejected" };
const ACCOUNT_STATUS_LABELS = {
  [ACCOUNT_STATUS.PENDING_REVIEW]: "قيد المراجعة",
  [ACCOUNT_STATUS.NEEDS_EDIT]: "يحتاج إلى تعديل",
  [ACCOUNT_STATUS.ACTIVE]: "مفعّل",
  [ACCOUNT_STATUS.REJECTED]: "مرفوض",
};
function getAccountStatus(user) {
  if (!user) return ACCOUNT_STATUS.ACTIVE;
  const s = user.accountStatus;
  if (s === ACCOUNT_STATUS.NEEDS_EDIT || s === ACCOUNT_STATUS.REJECTED || s === ACCOUNT_STATUS.PENDING_REVIEW) return s;
  return ACCOUNT_STATUS.ACTIVE; // missing/unknown/"active" -> active, never lock out an existing account
}

// ---- Registration fields the admin can flag for correction (and the
// referee can then edit) BEFORE their account is activated — i.e. the
// handful of fields captured at signup itself, not the full enrollment
// form (which only becomes reachable once the account is active). Kept as
// an explicit closed list — same reasoning as REF_RANKS/REF_ROLES below —
// so an admin's "طلب تعديل" (or a direct API call) can never name a field
// outside what the referee actually filled in at signup. ----
const REGISTRATION_FIELDS = [
  { key: "fullNameAr", label: "الاسم واللقب (بالعربية)" },
  { key: "fullNameLatin", label: "الاسم واللقب (باللاتينية)" },
  { key: "username", label: "اسم المستخدم" },
  { key: "email", label: "البريد الإلكتروني" },
  { key: "phone", label: "رقم الهاتف" },
];
const REGISTRATION_FIELD_KEYS = REGISTRATION_FIELDS.map((f) => f.key);
function isValidRegistrationField(key) {
  return REGISTRATION_FIELD_KEYS.includes(key);
}
function registrationFieldLabel(key) {
  const f = REGISTRATION_FIELDS.find((f) => f.key === key);
  return f ? f.label : key;
}

// ---- Name script validation ----
// The identity name is captured twice, in two different scripts: once in
// Arabic (the platform's primary language) and once in Latin letters (the
// French/English spelling used on official documents, bank/CCP paperwork,
// FAF/CAF forms, etc.). Each field only accepts characters from its own
// script — enforced here (server) and, in sync, in public/app.js (client,
// live while typing) — so the two can never end up with mismatched or
// mixed-script values. Character classes are exported as plain strings (not
// full RegExp) so both the server .test() pattern and the client's HTML
// `pattern` attribute can be built from the exact same source.
const ARABIC_NAME_CLASS = "\\u0600-\\u06FF\\s";
const LATIN_NAME_CLASS = "A-Za-zÀ-ÖØ-öø-ÿŒœ'\\-\\s";
const SCRIPT_CLASSES = { ar: ARABIC_NAME_CLASS, latin: LATIN_NAME_CLASS };
function isValidForScript(script, value) {
  const cls = SCRIPT_CLASSES[script];
  if (!cls) return true; // no script constraint on this field
  const v = String(value || "").trim();
  if (!v) return false;
  return new RegExp(`^[${cls}]+$`).test(v);
}

// ---- Username format ----
// Latin letters and digits only — no Arabic, no accented/French letters
// (unlike fullNameLatin above), no spaces or symbols. This keeps usernames
// safe to type on any keyboard and unambiguous for login.
const USERNAME_CLASS = "A-Za-z0-9";
const USERNAME_REGEX = new RegExp(`^[${USERNAME_CLASS}]+$`);
function isValidUsername(value) {
  return USERNAME_REGEX.test(String(value || "").trim());
}

// ---- Phone number format ----
// Algerian mobile numbers: 10 digits total, starting with the mobile
// operator prefix (05/06/07 — landlines start differently and aren't
// accepted here since this is specifically the referee's personal contact
// number). Digits only, no spaces/dashes, so it's unambiguous to store,
// search, and dial.
const PHONE_CLASS = "0-9";
const PHONE_REGEX = /^(05|06|07)\d{8}$/;
function isValidPhone(value) {
  return PHONE_REGEX.test(String(value || "").trim());
}

// ---- Email format ----
// something@something.something — local part restricted to Latin letters,
// digits, and the standard email separators (. _ % + -), so an address
// like "ahmed.b123@gmail.com" is fine but Arabic (or any other non-Latin
// script) anywhere in the address is rejected; domain likewise Latin/
// digits/hyphens with at least one dot. Deliberately not a full RFC 5322
// validator (those are notoriously over-strict/under-strict either way);
// this just rejects the obviously-malformed inputs the person described
// ("missing the @", "no dot in the domain", stray spaces, non-Latin
// characters).
const EMAIL_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
function isValidEmail(value) {
  return EMAIL_REGEX.test(String(value || "").trim());
}

// ---- Postal current account (CCP) format ----
// Every CCP on this platform is issued under the same fixed 8-digit prefix
// (00799999); the referee only ever types the remaining digits. Stored/
// validated as one 20-digit string: prefix + the referee-entered digits.
const CCP_PREFIX = "00799999";
const CCP_TOTAL_LENGTH = 20;
const CCP_REGEX = new RegExp(`^${CCP_PREFIX}\\d{${CCP_TOTAL_LENGTH - CCP_PREFIX.length}}$`);
function isValidCcp(value) {
  return CCP_REGEX.test(String(value || "").trim());
}

// ---- Season format ("موسم الدخول إلى التحكيم") ----
// Exactly "xxxx/xxxx" — 4 digits, a slash, 4 digits, nothing else — and the
// second year must be the first year + 1 (a real season, e.g. "2014/2015",
// never "2014/2016" or reversed as "2015/2014").
const SEASON_REGEX = /^(\d{4})\/(\d{4})$/;
function isValidSeason(value) {
  const v = String(value || "").trim();
  const m = SEASON_REGEX.exec(v);
  if (!m) return false;
  const y1 = parseInt(m[1], 10);
  const y2 = parseInt(m[2], 10);
  return y2 === y1 + 1;
}

// ---- Shoe size format ----
// Digits only, at most two of them (EU shoe sizes on this platform never
// exceed two digits — "40", "42"... ).
const SHOE_SIZE_REGEX = /^\d{1,2}$/;
function isValidShoeSize(value) {
  return SHOE_SIZE_REGEX.test(String(value || "").trim());
}

// ---- Clothing size format ----
// The referee kit's standard size list, letters only (matched
// case-insensitively — the client uppercases as the person types, but this
// stays case-insensitive too since data saved before that existed may not
// be uppercase yet).
const CLOTHING_SIZES = ["S", "M", "L", "XL", "XXL", "XXXL", "2XL", "3XL", "4XL"];
const CLOTHING_SIZE_REGEX = /^(XS|S|M|L|XXXL|XXL|XL|[2-4]XL)$/i;
function isValidClothingSize(value) {
  return CLOTHING_SIZE_REGEX.test(String(value || "").trim());
}
function normalizeClothingSize(value) {
  return String(value || "").trim().toUpperCase();
}

// ---- Per-field "format" validators ----
// Keyed by the `format` property on a FIELD_GROUPS field (see phone1/phone2/
// emergencyPhone/ccp/shoeSize/clothingSize below). A field with no `format`
// has no extra format check beyond `required`/`script`. Empty values are
// never flagged here — that's what `required` is for; a format validator
// only runs against a non-empty value, so optional fields left blank never
// trip it.
const FIELD_FORMAT_VALIDATORS = {
  phone: isValidPhone,
  ccp: isValidCcp,
  shoeSize: isValidShoeSize,
  clothingSize: isValidClothingSize,
  season: isValidSeason,
};
function isValidForFormat(format, value) {
  const fn = FIELD_FORMAT_VALIDATORS[format];
  if (!fn) return true;
  const v = String(value || "").trim();
  if (!v) return true; // emptiness is a `required` concern, not a format one
  return fn(v);
}

// Best-effort auto-correction applied server-side to every incoming
// field value that carries a `format` (see PUT /applications/mine), on top
// of — never instead of — the client-side live filtering. This is what
// stops someone from bypassing the client entirely (calling the API
// directly) and writing letters/symbols/over-length junk into these
// fields; it never rejects the autosave request, it just normalizes the
// value the same way the client would have.
function sanitizeForFormat(format, value) {
  const v = String(value == null ? "" : value);
  if (format === "phone") {
    return v.replace(/\D/g, "").slice(0, 10);
  }
  if (format === "shoeSize") {
    return v.replace(/\D/g, "").slice(0, 2);
  }
  if (format === "clothingSize") {
    return v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 4);
  }
  if (format === "season") {
    // Keep only digits and slashes while typing, then re-insert the slash
    // at the right spot (position 4) so a person can never end up with
    // "2014-2015", "2014/15", extra slashes, or letters — only ever
    // digits arranged as xxxx/xxxx.
    let digits = v.replace(/[^\d]/g, "").slice(0, 8);
    if (digits.length <= 4) return digits;
    return `${digits.slice(0, 4)}/${digits.slice(4)}`;
  }
  if (format === "ccp") {
    let digits = v.replace(/\D/g, "").slice(0, CCP_TOTAL_LENGTH);
    if (!digits.startsWith(CCP_PREFIX)) {
      const extra = Math.max(0, digits.length - CCP_PREFIX.length);
      const suffix = extra > 0 ? digits.slice(digits.length - extra) : "";
      digits = (CCP_PREFIX + suffix).slice(0, CCP_TOTAL_LENGTH);
    }
    return digits;
  }
  return v;
}

// ---- Referee rank ("الرتبة الحالية") — fixed, closed list. A select field
// only ever accepts one of these exact values, both because the frontend
// renders it as a <select> (nothing else is typeable) and because the
// server re-checks membership in this list at submit time (see
// isValidForOptions below) so the value can't be tampered with by calling
// the API directly. ----
const REF_RANKS = ["حكم جديد", "حكم متربص", "حكم ولائي", "حكم جهوي", "حكم مابين الرابطات", "حكم فدرالي", "حكم دولي"];

// ---- Referee capacity ("صفة التحكيم") — exactly two options. ----
const REF_ROLES = ["حكم رئيسي", "حكم مساعد"];

// Generic closed-list check for any select/radio field — used both for the
// fields above and for the platform's existing select/radio fields
// (maritalStatus, clubMember, availableWeekly) so a direct API call can
// never write a value outside the options the person was actually shown.
function isValidForOptions(field, value) {
  if (!field || !Array.isArray(field.options)) return true;
  return field.options.includes(String(value || ""));
}

const FIELD_GROUPS = [
  {
    key: "personal",
    title: "المعلومات الشخصية",
    fields: [
      { key: "fullNameAr", label: "الاسم واللقب (بالعربية)", type: "text", required: true, script: "ar" },
      { key: "fullNameLatin", label: "الاسم واللقب (باللاتينية)", type: "text", required: true, script: "latin" },
      { key: "birthDate", label: "تاريخ الازدياد", type: "date", required: true, notFuture: true },
      { key: "birthPlace", label: "مكان الازدياد", type: "text", required: true },
      { key: "maritalStatus", label: "الحالة العائلية", type: "select", required: true, options: ["أعزب", "متزوج(ة)", "مطلق(ة)", "أرمل(ة)"] },
      { key: "educationLevel", label: "المستوى التعليمي", type: "text", required: true },
      { key: "address", label: "العنوان الشخصي", type: "textarea", required: true, full: true },
    ],
  },
  {
    key: "contact",
    title: "معلومات الاتصال",
    fields: [
      { key: "phone1", label: "رقم الهاتف", type: "tel", required: true, format: "phone" },
      { key: "phone2", label: "الرقم الثاني (اختياري)", type: "tel", required: false, format: "phone" },
      { key: "email", label: "البريد الإلكتروني", type: "email", required: true },
      { key: "job", label: "الوظيفة", type: "text", required: true },
      { key: "emergencyName", label: "اسم الشخص المتصل به في حالة الطوارئ", type: "text", required: true },
      { key: "emergencyPhone", label: "رقم هاتف شخص الطوارئ", type: "tel", required: true, format: "phone" },
      { key: "ccp", label: "رقم الحساب الجاري البريدي (CCP)", type: "text", required: true, full: true, format: "ccp" },
    ],
  },
  {
    key: "refereeing",
    title: "معلومات التحكيم",
    fields: [
      { key: "clubMember", label: "هل تنتمي إلى نادٍ؟", type: "radio", required: true, options: ["نعم", "لا"] },
      { key: "clubName", label: "اسم النادي (إن وجد)", type: "text", required: false },
      { key: "avoidClubs", label: "النوادي التي قد تتجنبها", type: "text", required: false, full: true },
      { key: "refStartDate", label: "موسم الدخول إلى التحكيم", type: "text", required: true, format: "season", placeholder: "2014/2015" },
      { key: "refLevel", label: "الرتبة الحالية", type: "select", required: true, options: REF_RANKS },
      { key: "refRole", label: "صفة التحكيم", type: "radio", required: true, options: REF_ROLES },
      { key: "availableWeekly", label: "هل أنت متاح خلال الأسبوع؟", type: "radio", required: true, options: ["نعم", "لا"] },
      { key: "shoeSize", label: "مقاس الحذاء", type: "text", required: true, format: "shoeSize" },
      { key: "clothingSize", label: "مقاس اللباس", type: "text", required: true, format: "clothingSize" },
    ],
  },
];

function allFieldKeys() {
  return FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
}

function blankData() {
  const data = {};
  allFieldKeys().forEach((k) => (data[k] = ""));
  // The CCP field always starts pre-filled with the fixed platform prefix —
  // the referee only ever types the digits that follow it (see the CCP
  // format note above).
  data.ccp = CCP_PREFIX;
  return data;
}

// ---- Referee request statuses (absence / special / edit-info requests) ----
// 🟠 قيد المراجعة -> 🔵 يحتاج إلى توضيح/تعديل (loops back to 🟠) -> 🟢 مقبول
// أو 🔴 مرفوض (both terminal — final and closed for the referee).
const REQUEST_STATUS = {
  PENDING: "pending",
  NEEDS_CLARIFICATION: "needs_clarification",
  APPROVED: "approved",
  REJECTED: "rejected",
};
const REQUEST_STATUS_LABELS = {
  [REQUEST_STATUS.PENDING]: "قيد المراجعة",
  [REQUEST_STATUS.NEEDS_CLARIFICATION]: "يحتاج إلى توضيح/تعديل",
  [REQUEST_STATUS.APPROVED]: "مقبول",
  [REQUEST_STATUS.REJECTED]: "مرفوض",
};
const REQUEST_FINAL_STATUSES = [REQUEST_STATUS.APPROVED, REQUEST_STATUS.REJECTED];

// ---- Phone number uniqueness (رقم الهاتف الرئيسي / الرقم الثاني) ----
// Enforced across BOTH the account-level `phone` (set at signup, mirrors
// phone1) and every application's `data.phone1`/`data.phone2` — a referee's
// phone1/phone2 must never collide with ANY other referee's phone1 or
// phone2, in any combination. رقم هاتف شخص الطوارئ (`emergencyPhone`) is
// deliberately never part of this map — it is excluded on purpose, not by
// omission (see the twelfth requirement in the requests/notifications/
// announcements upgrade spec: the emergency contact number is explicitly
// exempt from the uniqueness rule and must never trigger "رقم مستخدم
// مسبقًا").
function collectUsedPhones(data, excludeUserId) {
  const map = new Map(); // normalized phone -> owning userId
  (data.users || []).forEach((u) => {
    if (excludeUserId && u.id === excludeUserId) return;
    const v = String(u.phone || "").trim();
    if (v) map.set(v, u.id);
  });
  (data.applications || []).forEach((a) => {
    if (excludeUserId && a.userId === excludeUserId) return;
    const d = a.data || {};
    const p1 = String(d.phone1 || "").trim();
    const p2 = String(d.phone2 || "").trim();
    if (p1) map.set(p1, a.userId);
    if (p2) map.set(p2, a.userId);
  });
  return map;
}

// Checks phone1/phone2 (never emergencyPhone) against every OTHER
// account's phone1/phone2 (and legacy `user.phone`). Pass `excludeUserId`
// to allow a referee to keep their own current number(s) unchanged.
// Returns { ok: true } or { ok: false, field: "phone1"|"phone2", message }.
function checkPhoneUniqueness(data, { phone1, phone2 }, excludeUserId) {
  const used = collectUsedPhones(data, excludeUserId);
  const p1 = String(phone1 || "").trim();
  const p2 = String(phone2 || "").trim();
  if (p1 && used.has(p1)) {
    return { ok: false, field: "phone1", message: "رقم الهاتف الرئيسي مستخدم بالفعل من طرف حكم آخر." };
  }
  if (p2 && used.has(p2)) {
    return { ok: false, field: "phone2", message: "الرقم الثاني مستخدم بالفعل من طرف حكم آخر." };
  }
  return { ok: true };
}

// ---- Profile photo lookup ----
// The referee's photo isn't stored on the user account itself — it's one of
// the enrollment application's uploaded documents (docKey "photo", see
// documentRequirementsCore.js), so showing it as a chat avatar means
// looking it up via their application each time rather than reading a
// field directly off the user object.
function getUserPhotoUrl(data, userId) {
  const app = (data.applications || []).find((a) => a.userId === userId);
  return (app && app.documents && app.documents.photo && app.documents.photo.url) || null;
}

// ---- Single source of truth: mirroring identity fields onto the account
// record ----
// The referee's identity/contact data conceptually lives in ONE place —
// the enrollment application's `data` object (application.data), which is
// what every referee/admin-facing edit path actually writes to (the
// enrollment form, the admin's direct-edit screen, an approved "طلب تعديل
// معلومة"). The account record (`user`) keeps its own copies of a handful
// of these fields ONLY because they're needed in places that must resolve
// fast without loading the application (login, JWT payload, chat member
// lists, notifications, typing indicators, the "كل الحسابات المسجَّلة"
// admin list) — see routes/chat.js, routes/admin.js, routes/requests.js.
//
// Those account-level copies are a MIRROR, never an independent source.
// This map is the single place that says which application.data key
// mirrors onto which user key — every write path MUST call
// syncUserFromApplicationData() after touching application.data, instead
// of hand-rolling its own partial sync (the old code only ever synced
// phone1 → user.phone, silently leaving user.fullNameAr/fullNameLatin/
// email stale after a name or email edit — see auditCore.js and the three
// call sites in routes/applications.js, routes/admin.js).
const IDENTITY_MIRROR = { fullNameAr: "fullNameAr", fullNameLatin: "fullNameLatin", email: "email", phone1: "phone" };

// Given a referee's `user` record and their (already-updated) application
// `appData`, mirrors every identity field that has a value onto the user
// record. Pass `onlyKeys` (an array of application.data keys, e.g.
// ["fullNameAr"]) to restrict the sync to just the fields that were
// actually touched in this request — every call site does this so a save
// that only changed `job` never rewrites (and re-audit-logs) untouched
// identity fields. Returns the list of { field, fieldLabel, oldValue,
// newValue } diffs that actually changed, for the caller to hand to
// auditCore.addAuditEntries().
function syncUserFromApplicationData(user, appData, onlyKeys) {
  if (!user || !appData) return [];
  const diffs = [];
  Object.entries(IDENTITY_MIRROR).forEach(([appKey, userKey]) => {
    if (onlyKeys && !onlyKeys.includes(appKey)) return;
    if (appData[appKey] === undefined) return;
    const oldValue = user[userKey];
    const newValue = appData[appKey];
    if (String(oldValue ?? "") !== String(newValue ?? "")) {
      diffs.push({ field: appKey, oldValue, newValue });
      user[userKey] = newValue;
    }
  });
  return diffs;
}

module.exports = {
  SEASON, FIELD_GROUPS, allFieldKeys, blankData, ACCOUNT_STATUS, ACCOUNT_STATUS_LABELS, getAccountStatus,
  REGISTRATION_FIELDS, REGISTRATION_FIELD_KEYS, isValidRegistrationField, registrationFieldLabel,
  IDENTITY_MIRROR, syncUserFromApplicationData,
  ARABIC_NAME_CLASS, LATIN_NAME_CLASS, isValidForScript,
  USERNAME_CLASS, isValidUsername,
  PHONE_CLASS, isValidPhone,
  isValidEmail,
  CCP_PREFIX, CCP_TOTAL_LENGTH, isValidCcp,
  isValidShoeSize,
  CLOTHING_SIZES, isValidClothingSize, normalizeClothingSize,
  SEASON_REGEX, isValidSeason,
  REF_RANKS, REF_ROLES, isValidForOptions,
  isValidForFormat, sanitizeForFormat,
  getUserPhotoUrl,
  REQUEST_STATUS, REQUEST_STATUS_LABELS, REQUEST_FINAL_STATUSES,
  checkPhoneUniqueness,
};
