// db.js — MongoDB Atlas-backed persistence layer (finance-system side).
//
// The entire platform state (users, applications, requests, finance data,
// ...) is kept as ONE document in a single MongoDB collection. This keeps
// every route in the project completely unchanged (they all call
// db.getAll() / db.saveAll()), while giving the platform real, permanent,
// cross-device persistence.
//
// IMPORTANT — this collection is SHARED with the separately-deployed
// "lwf-referee-platform" project (same DB_NAME/COLLECTION_NAME/DOC_ID
// below). The finance module used to be mounted inside that same server;
// it has been split out into this standalone project/deployment, but both
// still read and write the same underlying document on purpose, so that
// existing user accounts (admin, finance_admin, finance_viewer, referees),
// login, and all previously-recorded data keep working with zero
// migration. This file keeps the FULL schema/migrations (referee fields
// included) exactly as before, so whichever of the two projects happens to
// create the document first on a brand-new database still ends up with a
// complete, consistent shape.
//
// Note: MongoDB documents have a 16MB size limit. For a single wilaya
// referee registry (hundreds of files per season, text-only — uploaded
// files themselves live on Cloudinary, not here) this is enormous headroom.
// If the platform ever grows to serve many wilayas / tens of thousands of
// referees, migrate to one document per user/application instead.

const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");
const { MONGODB_URI } = require("./config");

const DB_NAME = "lwf_referees";
const COLLECTION_NAME = "platform_state";
const DOC_ID = "singleton";

let client = null;
let collectionPromise = null;

const { DEFAULT_SETTINGS } = require("./settingsCore");
const { seedDocumentRequirements } = require("./documentRequirementsCore");
const { syncUserFromApplicationData } = require("./schema");
const { addAuditEntries } = require("./auditCore");
const { DEFAULT_FINANCE_SETTINGS, renumberTransactionsAfterDeletion } = require("./financeCore");

function defaultData() {
  return {
    users: [], applications: [], requests: [], conversations: [], conversationMembers: [], messages: [], announcements: [],
    notifications: [],
    refereeLists: [],
    settings: { ...DEFAULT_SETTINGS },
    documentRequirements: seedDocumentRequirements(),
    auditLog: [],
    // ---- Finance module ("المالية") ----
    financeTransactions: [],
    // اللجنة — the committee/activity an expense was made FOR (e.g. لجنة
    // التحكيم، اللجنة الفنية). Kept on its original `financeCategories`
    // storage name for backward compatibility with every already-recorded
    // transaction's categoryId — only its label/meaning was clarified, not
    // its storage key (see financeCore.js).
    financeCategories: [],
    // جهة الصرف — the entity the money was actually paid TO (e.g. مطعم
    // الشاف، فندق، شركة). A brand-new, fully independent collection — never
    // merged with financeCategories above (section "ثامنًا" of the برنامج
    // update).
    financePayees: [],
    // Financial years ("السنوات المالية"). The platform used to also have
    // an independent "الموسم الرياضي" (sporting season) concept here — it
    // has been removed entirely in favour of relying on financial years
    // alone (see the one-time migration in getAll() below, and
    // routes/finance.js). A financial year is a single calendar-style year
    // (e.g. 2025) with its own opening balance; every transaction belongs
    // to exactly one, and no two years' data may ever mix (see
    // financeCore.js).
    financeYears: [],
    financeAuditLog: [],
    financeSettings: { ...DEFAULT_FINANCE_SETTINGS },
  };
}

async function connect() {
  if (collectionPromise) return collectionPromise;

  if (!MONGODB_URI) {
    throw new Error(
      "متغير البيئة MONGODB_URI غير معرَّف. أضف رابط الاتصال بقاعدة بيانات MongoDB Atlas في ملف .env (محليًا) أو في إعدادات متغيرات البيئة على منصة الاستضافة."
    );
  }

  collectionPromise = (async () => {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const database = client.db(DB_NAME);
    const collection = database.collection(COLLECTION_NAME);

    const existing = await collection.findOne({ _id: DOC_ID });
    if (!existing) {
      await collection.insertOne({ _id: DOC_ID, ...defaultData() });
    }
    return collection;
  })();

  return collectionPromise;
}

async function getAll() {
  const collection = await connect();
  const doc = await collection.findOne({ _id: DOC_ID });
  const data = doc || defaultData();

  // Backfill keys that may be missing from an older version of the platform,
  // so upgrades never crash on startup.
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.applications)) data.applications = [];
  if (!Array.isArray(data.requests)) data.requests = [];
  if (!Array.isArray(data.conversations)) data.conversations = [];
  if (!Array.isArray(data.conversationMembers)) data.conversationMembers = [];
  if (!Array.isArray(data.messages)) data.messages = [];
  if (!Array.isArray(data.announcements)) data.announcements = [];
  if (!Array.isArray(data.notifications)) data.notifications = [];
  if (!Array.isArray(data.refereeLists)) data.refereeLists = [];
  if (!data.settings || typeof data.settings !== "object") data.settings = { ...DEFAULT_SETTINGS };
  if (!Array.isArray(data.documentRequirements)) data.documentRequirements = seedDocumentRequirements();
  if (!Array.isArray(data.auditLog)) data.auditLog = [];
  // Finance module — backfills a platform database created before this
  // module existed, so upgrades never crash on startup (same reasoning as
  // every other backfill in this function).
  if (!Array.isArray(data.financeTransactions)) data.financeTransactions = [];
  if (!Array.isArray(data.financeCategories)) data.financeCategories = [];
  if (!Array.isArray(data.financePayees)) data.financePayees = [];
  if (!Array.isArray(data.financeYears)) data.financeYears = [];
  if (!Array.isArray(data.financeAuditLog)) data.financeAuditLog = [];
  if (!data.financeSettings || typeof data.financeSettings !== "object") {
    data.financeSettings = { ...DEFAULT_FINANCE_SETTINGS };
  } else {
    data.financeSettings = { ...DEFAULT_FINANCE_SETTINGS, ...data.financeSettings };
  }

  // One-time cleanup: the finance module used to also have a "الموسم
  // الرياضي" (sporting season) concept, fully independent from the
  // financial-year system above — it has been removed entirely (backend,
  // API, and frontend all dropped it). A platform document saved before
  // this change may still be carrying the old `financeSeasons` collection
  // and per-record `seasonId`/`currentSeasonId` references; strip them here
  // so no stale field or data ever lingers in the database, and persist the
  // cleanup immediately (same reasoning as the identity-mirror repair
  // further below) rather than waiting for some unrelated route to save
  // next. Every other field on every affected record is left untouched.
  let removedLegacySeasons = false;
  if (Array.isArray(data.financeSeasons)) {
    delete data.financeSeasons;
    removedLegacySeasons = true;
  }
  if (data.financeSettings && data.financeSettings.currentSeasonId !== undefined) {
    delete data.financeSettings.currentSeasonId;
    removedLegacySeasons = true;
  }
  (data.financeTransactions || []).forEach((t) => {
    if (t && t.seasonId !== undefined) {
      delete t.seasonId;
      removedLegacySeasons = true;
    }
  });
  if (removedLegacySeasons) {
    try {
      const collection = await connect();
      await collection.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...data }, { upsert: true });
    } catch (e) {
      console.error("تعذر حفظ إزالة بيانات الموسم الرياضي القديمة من النظام المالي:", e);
    }
  }

  // Migration: financial years ("السنوات المالية") didn't exist before —
  // any transaction recorded before this feature has no financialYearId at
  // all. Rather than lose/orphan that data (rule: never delete an existing
  // feature's data), auto-create one financial year per calendar year
  // already present in the ledger, opening balance 0 (unknown historically,
  // admin can correct it from the السنوات المالية screen), and attach every
  // transaction to the year matching its own date. The most recent such
  // year becomes the active financial year so the platform is immediately
  // usable after the upgrade.
  if (data.financeYears.length === 0 && data.financeTransactions.length > 0) {
    const now = new Date().toISOString();
    const yearNumbers = Array.from(
      new Set(data.financeTransactions.map((t) => parseInt(String(t.date || "").slice(0, 4), 10)).filter((y) => Number.isFinite(y)))
    ).sort((a, b) => a - b);
    const yearIdByNumber = new Map();
    yearNumbers.forEach((yearNumber) => {
      const id = uuidv4();
      yearIdByNumber.set(yearNumber, id);
      data.financeYears.push({
        id, year: yearNumber, openingBalanceCents: 0, status: "active",
        createdAt: now, createdBy: null, createdByName: "ترحيل تلقائي عند التحديث",
      });
    });
    data.financeTransactions.forEach((t) => {
      const y = parseInt(String(t.date || "").slice(0, 4), 10);
      t.financialYearId = yearIdByNumber.get(y) || null;
    });
    if (!data.financeSettings.activeFinancialYearId && yearNumbers.length) {
      data.financeSettings.activeFinancialYearId = yearIdByNumber.get(yearNumbers[yearNumbers.length - 1]);
    }
  }
  // Backfill: any transaction still missing financialYearId (created after
  // the migration above ran once, e.g. a race, or a fresh empty ledger)
  // falls back to the active year. Also backfill the time/occurredAt
  // fields added alongside the financial-years feature (see financeCore.js)
  // so older transactions (date only, no time-of-day) keep working and sort
  // correctly against new ones.
  data.financeTransactions.forEach((t) => {
    if (!t.financialYearId && data.financeSettings.activeFinancialYearId) {
      t.financialYearId = data.financeSettings.activeFinancialYearId;
    }
    if (!t.time) t.time = "00:00";
    if (!t.occurredAt) t.occurredAt = `${t.date}T${t.time}:00`;
    // جهة الصرف (payeeId) is a brand-new field — a transaction recorded
    // before it existed simply has none (shown as "—" in every list/report/
    // export/print). Never guessed at, never backfilled from اللجنة
    // (categoryId) — the two are unrelated concepts (section "ثامنًا").
    if (t.payeeId === undefined) t.payeeId = null;
  });

  // One-time migration: transaction numbering is ONE unified 1..N sequence
  // per financial year, shared by income AND expense transactions together
  // (see financeCore.js: transactionNumberScopeKey /
  // renumberTransactionsAfterDeletion — رقم العملية لا علاقة له بنوع
  // العملية). An earlier version of this platform scoped numbering
  // per-(type, financial year) instead — income and expense each had their
  // OWN 1..N sequence — which is the exact bug this migration repairs.
  // Any platform document saved under either the old flat scheme or that
  // incorrect per-type scheme has transaction numbers that don't reflect
  // unified-per-year numbering (and may still carry gaps from earlier
  // deletions). Repair it once: renumbering is idempotent and safe to run
  // on every scope, so this reuses the exact same function the delete route
  // calls, then flips a flag so this never re-runs needlessly. Must run
  // AFTER the financialYearId backfill above, since it groups by
  // financialYearId.
  if (data.financeSettings.transactionNumberingVersion !== 2) {
    if ((data.financeTransactions || []).length) {
      renumberTransactionsAfterDeletion(data);
    }
    delete data.financeSettings.transactionNumberingScoped; // superseded flag from the old (buggy) migration
    data.financeSettings.transactionNumberingVersion = 2;
    try {
      const collection = await connect();
      await collection.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...data }, { upsert: true });
    } catch (e) {
      console.error("تعذر حفظ ترحيل ترقيم العمليات المالية (تسلسل موحّد لكل سنة مالية):", e);
    }
  }

  // Migration: the identity name used to be one field (`fullName`); it's
  // now two, `fullNameAr` + `fullNameLatin` (see schema.js). Accounts and
  // applications created before this change only have the old field —
  // best-effort carry its value into fullNameAr (it was typed in Arabic in
  // practice, since the whole platform is Arabic-first) and leave
  // fullNameLatin blank rather than guessing at a transliteration; an admin
  // can ask the referee to fill it in via a future profile-edit feature, or
  // set it directly. This never overwrites a value that's already there.
  data.users.forEach((u) => {
    if (!u.fullNameAr && u.fullName) u.fullNameAr = u.fullName;
    if (u.fullNameLatin === undefined) u.fullNameLatin = u.fullNameLatin || "";
    // Migration: account activation review — every referee account now
    // carries these fields (see schema.js ACCOUNT_STATUS). Older accounts
    // predate this system, so backfill blank/neutral defaults without
    // touching accountStatus itself (getAccountStatus() already treats a
    // missing/unrecognized value as "active" — this only adds the bookkeeping
    // fields alongside it, it never changes anyone's actual status).
    if (!Array.isArray(u.reviewFields)) u.reviewFields = [];
    if (u.reviewNote === undefined) u.reviewNote = null;
    if (u.rejectionReason === undefined) u.rejectionReason = null;
    if (!Array.isArray(u.registrationHistory)) {
      u.registrationHistory = [{ at: u.createdAt || new Date().toISOString(), event: "تم إنشاء الحساب وإرسال التسجيل", by: null, byRole: null }];
    }
  });
  data.applications.forEach((a) => {
    if (a.data) {
      if (!a.data.fullNameAr && a.data.fullName) a.data.fullNameAr = a.data.fullName;
      if (a.data.fullNameLatin === undefined) a.data.fullNameLatin = a.data.fullNameLatin || "";
    }
  });

  // Migration: announcement `readBy` used to be a plain array of userIds
  // (whether the referee opened the announcement, no timestamp). It's now
  // an array of { userId, readAt } so the admin's read-tracking table can
  // show *when* each referee read it (see ninth requirement in the
  // request/notification/announcement upgrade). Old string entries are
  // carried over with readAt left null rather than guessed at.
  data.announcements.forEach((a) => {
    if (Array.isArray(a.readBy) && a.readBy.length && typeof a.readBy[0] === "string") {
      a.readBy = a.readBy.map((userId) => ({ userId, readAt: null }));
    } else if (!Array.isArray(a.readBy)) {
      a.readBy = [];
    }
  });

  // Migration: referee requests predate the قيد المراجعة/يحتاج إلى
  // توضيح/مقبول/مرفوض status + timeline system — backfill `history` and
  // `previousVersions` so older requests don't crash the new UI/routes.
  (data.requests || []).forEach((r) => {
    if (!Array.isArray(r.history)) r.history = [];
    if (!Array.isArray(r.previousVersions)) r.previousVersions = [];
  });

  // Self-healing repair: single source of truth for referee identity data.
  // application.data (the enrollment form) is the field the referee/admin
  // actually edit; the account record (`user`) only ever keeps a MIRROR of
  // fullNameAr/fullNameLatin/email/phone1→phone for the places that need it
  // without loading the application (chat, notifications, the admin account
  // list — see schema.js IDENTITY_MIRROR). Older code only ever synced
  // phone1, so any account whose name/email was edited before this fix will
  // have a stale mirror. This repairs that drift automatically, the first
  // time each affected record is loaded — it changes nothing in the
  // browser/API surface, and every actual correction is written to the
  // Audit Log (source: "system_sync") so an admin can see exactly which
  // records were affected and when. This block runs on every getAll() call
  // but is a no-op (just comparisons, no writes) once every record is in
  // sync, which is true after the very first save that follows.
  let repaired = false;
  data.applications.forEach((app) => {
    if (!app.data || !app.userId) return;
    const owner = data.users.find((u) => u.id === app.userId);
    if (!owner) return;
    const diffs = syncUserFromApplicationData(owner, app.data);
    if (diffs.length) {
      repaired = true;
      addAuditEntries(data, app.userId, diffs, {
        changedBy: "admin",
        changedByUserId: null,
        changedByName: "تصحيح تلقائي عند الترقية",
        source: "system_sync",
        reason: "إصلاح تلقائي لبيانات كانت غير متزامنة بين ملف الحكم وحسابه (قبل توحيد مصدر البيانات).",
        accountStatusBefore: null,
        accountStatusAfter: null,
      });
    }
  });
  if (repaired) {
    // Persist the repair immediately rather than waiting for some unrelated
    // route to save next — an admin opening a read-only list page (e.g.
    // "كل الحسابات المسجَّلة") should see corrected data right away, and the
    // audit entries above must not be silently lost if the process restarts
    // before anything else triggers a save.
    try {
      const collection = await connect();
      await collection.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...data }, { upsert: true });
    } catch (e) {
      console.error("تعذر حفظ الإصلاح التلقائي لتزامن بيانات الحكام:", e);
    }
  }

  return data;
}

async function saveAll(data) {
  const collection = await connect();
  await collection.replaceOne({ _id: DOC_ID }, { _id: DOC_ID, ...data }, { upsert: true });
  return data;
}

// ---- Chat: atomic operations on the messages array ----
//
// Messages are written far more often than any other data in this platform
// (every chat message, edit, delete). Going through getAll()/saveAll() would
// read-modify-write the ENTIRE document on every message, which both wastes
// bandwidth and risks silently dropping a concurrent message (two users
// sending at the same instant would race on the same full-document replace).
// These helpers instead issue targeted MongoDB array operators so concurrent
// chat activity is safe.

async function pushMessage(message) {
  const collection = await connect();
  await collection.updateOne({ _id: DOC_ID }, { $push: { messages: message } });
  return message;
}

async function updateMessageById(id, patch) {
  const collection = await connect();
  const setObj = {};
  Object.entries(patch).forEach(([k, v]) => { setObj[`messages.$.${k}`] = v; });
  const result = await collection.updateOne({ _id: DOC_ID, "messages.id": id }, { $set: setObj });
  return result.matchedCount > 0;
}

async function deleteMessagesByConversation(conversationId) {
  const collection = await connect();
  await collection.updateOne({ _id: DOC_ID }, { $pull: { messages: { conversationId } } });
}

async function touchConversation(conversationId, iso) {
  const collection = await connect();
  await collection.updateOne(
    { _id: DOC_ID, "conversations.id": conversationId },
    { $set: { "conversations.$.updatedAt": iso, "conversations.$.lastMessageAt": iso } }
  );
}

// ---- Presence: last-seen persistence ----
// Same targeted-update reasoning as updateMessageById above — this fires on
// every disconnect (closing a tab, losing signal, logging out), so it must
// not read-modify-write the whole platform document each time.
async function updateUserById(id, patch) {
  const collection = await connect();
  const setObj = {};
  Object.entries(patch).forEach(([k, v]) => { setObj[`users.$.${k}`] = v; });
  const result = await collection.updateOne({ _id: DOC_ID, "users.id": id }, { $set: setObj });
  return result.matchedCount > 0;
}

// ---- Finance: atomic transaction-number counter ----
// Two admins hitting "حفظ" on a new transaction at the same instant must
// never receive the same transactionNumber — a plain getAll()/saveAll()
// read-modify-write on the whole document could race and hand out a
// duplicate. $inc is atomic at the MongoDB level regardless of concurrent
// requests, so this is the one piece of finance state that bypasses the
// single-document getAll()/saveAll() pattern on purpose.
//
// `scopeKey` is financeCore.transactionNumberScopeKey(financialYearId) —
// numbering is ONE unified sequence per financial year, shared by income
// and expense together, so each financial year gets its own counter field
// under financeSettings.transactionCounters.<scopeKey>. A scope's counter
// is missing the first time it's used, which Mongo's $inc treats as 0 —
// returnDocument:"after" then hands back exactly the number to use (1 the
// first time, 2 the next, ...), no separate "before" bookkeeping needed.
async function nextFinanceTransactionNumber(scopeKey) {
  const collection = await connect();
  const field = `financeSettings.transactionCounters.${scopeKey}`;
  const result = await collection.findOneAndUpdate(
    { _id: DOC_ID },
    { $inc: { [field]: 1 } },
    { returnDocument: "after", upsert: true, includeResultMetadata: true }
  );
  // Driver v6 defaults to returning the document directly, but we pass
  // includeResultMetadata:true above specifically so this always has a
  // stable `.value` shape regardless of driver minor-version defaults.
  const after = result && result.value ? result.value.financeSettings : null;
  const counters = after && after.transactionCounters ? after.transactionCounters : null;
  const n = counters && typeof counters[scopeKey] === "number" ? counters[scopeKey] : 1;
  return n;
}

module.exports = {
  connect, getAll, saveAll,
  pushMessage, updateMessageById, deleteMessagesByConversation, touchConversation, updateUserById,
  nextFinanceTransactionNumber,
};
