// financeCore.js — business logic for the "المالية" (finance) module.
//
// Kept separate from the referee-registration domain (schema.js/auditCore.js
// etc.) on purpose: the finance ledger is a completely independent concern
// that happens to live in the same platform document, so mixing its logic
// into the referee-focused files would make both harder to reason about.
//
// ---- Money handling ------------------------------------------------------
// Every amount is stored as an INTEGER number of centimes (amount * 100),
// never as a float and never as a string used for arithmetic. This is what
// rule #7 in the project brief ("لا تستخدم أرقامًا مالية تقريبية") is about:
// 0.1 + 0.2 !== 0.3 in floating point, and a financial ledger can never be
// allowed to drift by even one centime. All arithmetic in this file works
// on these integer cents; only display formatting ever divides by 100.

const { v4: uuidv4 } = require("uuid");

const TRANSACTION_TYPES = { INCOME: "income", EXPENSE: "expense" };
const ENTITY_STATUS = { ACTIVE: "active", DISABLED: "disabled" };
const ALLOWED_ATTACHMENT_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/jpg"];

const DEFAULT_FINANCE_SETTINGS = {
  currency: "DZD",
  ligueNameAr: "الرابطة الولائية لكرة القدم الوادي",
  ligueNameFr: "LIGUE WILAYA DE FOOTBALL ELOUED",
  logoUrl: null,
  numberingPadding: 6,
  // Legacy flat counter — kept only so old stored settings objects don't
  // break the {...DEFAULT, ...stored} merge in getFinanceSettings(); no
  // longer used to hand out numbers (see transactionCounters below).
  nextTransactionNumber: 1,
  // Per-scope "next number to hand out" counters, keyed by
  // transactionNumberScopeKey(financialYearId) — one unified 1..N
  // sequence per financial year, shared by BOTH income and expense
  // transactions together (rule: رقم العملية يمثل ترتيب جميع العمليات
  // المالية معًا — the transaction's type never affects its number).
  // Mutated in place by db.nextFinanceTransactionNumber() (atomic, per
  // scope) and by renumberTransactionsAfterDeletion() below.
  transactionCounters: {},
  enforceNoOverdraft: true,
  // The currently-selected financial year ("السنة المالية النشطة"). No
  // financial operation (add/view/edit/search/report/export/print/balance)
  // runs without one — see financeCore.js's financial-years section below.
  activeFinancialYearId: null,
};

function getFinanceSettings(data) {
  const stored = (data && data.financeSettings) || {};
  return { ...DEFAULT_FINANCE_SETTINGS, ...stored };
}

// ---- Financial years ("السنوات المالية") --------------------------------
// A financial year is a single calendar-style year (2025, 2026, ...) with
// its own opening balance. Every transaction belongs to exactly one
// (transaction.financialYearId) and every financial computation below is
// scoped to one financial year at a time — years never mix (per the
// project brief's "أولاً: تطوير نظام السنوات المالية").
const FINANCIAL_YEAR_STATUS = { ACTIVE: "active", DISABLED: "disabled" };

function getActiveFinancialYearId(data) {
  return getFinanceSettings(data).activeFinancialYearId || null;
}

function getFinancialYear(data, financialYearId) {
  return (data.financeYears || []).find((y) => y.id === financialYearId) || null;
}

function validateFinancialYearInput(input, data, { isUpdate = false, excludeId = null } = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "بيانات السنة المالية غير صحيحة." };
  const yearNumber = parseInt(input.year, 10);
  if (!Number.isFinite(yearNumber) || yearNumber < 1900 || yearNumber > 2200) {
    return { ok: false, error: "السنة المالية غير صحيحة (مثال: 2025)." };
  }
  const duplicate = (data.financeYears || []).some((y) => y.year === yearNumber && y.id !== excludeId);
  if (duplicate) return { ok: false, error: "توجد سنة مالية بهذه السنة مسبقًا." };

  let openingBalanceCents = 0;
  if (!isUpdate || input.openingBalance !== undefined) {
    const cents = toCents(input.openingBalance);
    if (cents === null || cents < 0) return { ok: false, error: "الرصيد الافتتاحي يجب أن يكون رقمًا صحيحًا (0 أو أكبر)." };
    openingBalanceCents = cents;
  }
  return { ok: true, value: { year: yearNumber, openingBalanceCents } };
}

// Balance/income/expense for ONE financial year only — opening balance +
// income - expense, strictly scoped to that year's own transactions.
function computeFinancialYearBalance(data, financialYearId) {
  const year = getFinancialYear(data, financialYearId);
  const list = (data.financeTransactions || []).filter((t) => t.financialYearId === financialYearId);
  let income = 0, expense = 0;
  list.forEach((t) => {
    if (t.type === TRANSACTION_TYPES.INCOME) income += t.amountCents;
    else expense += t.amountCents;
  });
  const openingBalanceCents = year ? year.openingBalanceCents : 0;
  return {
    openingBalanceCents,
    totalIncomeCents: income,
    totalExpenseCents: expense,
    balanceCents: openingBalanceCents + income - expense,
    transactionCount: list.length,
  };
}

// Every financial year with its computed stats — used for the year-switcher
// list and the "السنوات المالية" management screen.
function listFinancialYears(data) {
  return (data.financeYears || [])
    .slice()
    .sort((a, b) => b.year - a.year)
    .map((y) => ({ ...y, ...computeFinancialYearBalance(data, y.id) }));
}

// ---- Money formatting -----------------------------------------------------
// Always renders as "12,670.00 دج" — two decimals, thousands separators,
// currency suffix — the same everywhere in the app (rule: never show a
// financial number in more than one shape).
function formatAmount(cents) {
  const n = (Number(cents) || 0) / 100;
  const formatted = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} دج`;
}

// ---- Date formatting for exported/printed reports --------------------------
// Report periods (PDF/Excel) must show only a plain day/month/year date —
// never the day name, the time, or any other extra information — in the
// exact "DD/MM/YYYY" shape. Input is always the app's own "YYYY-MM-DD"
// date string; anything else is returned unchanged rather than guessed at.
function formatDateDMY(isoDate) {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate));
  if (!m) return String(isoDate);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// ---- Display ordering (ترتيب العمليات حسب التاريخ والوقت) -----------------
// Every screen, report, export, and print that lists transactions must
// order them by their real date+time (occurredAt) — never by the stored
// رقم العملية, and never by row/insertion order — so the same choice
// (تصاعدي/تنازلي) produces the exact same order everywhere. "oldest" means
// تصاعدي (من الأقدم إلى الأحدث)؛ "newest" means تنازلي (من الأحدث إلى
// الأقدم). Ties (same date+time) fall back to createdAt so the order is
// always fully deterministic. This is purely a DISPLAY/EXPORT/PRINT
// ordering — the running balance (see withRunningBalance below) always
// stays computed in true chronological (occurredAt) order regardless of
// what order the rows are laid out in afterwards, so the "الرصيد" column
// is never affected by this choice.
function orderByOccurredAt(list, order) {
  const sorted = chronological(list); // always oldest -> newest first
  if (order === "newest") sorted.reverse();
  return sorted;
}

// رقم العملية المعروض (displayNumber) is a PURE display/position sequence —
// it always starts at 1 and counts up (1 → 2 → 3 → ...) in whatever order
// the rows are currently laid out in, and it is NEVER reversed when the
// order is تنازلي. It has nothing to do with the transaction's own stored
// `transactionNumber` (a permanent per-transaction reference kept for
// search/audit purposes) — this is computed fresh every time a list is
// built, over the already-ordered array, so pagination simply continues the
// same running count across pages (page 2 of a 20-per-page list starts at
// 21) rather than resetting to 1 on every page.
function withDisplayNumbers(list, startAt = 1) {
  return list.map((t, i) => ({ ...t, displayNumber: startAt + i }));
}

// Retained for any external caller that still needs to sort strictly by the
// stored transactionNumber (e.g. a future admin diagnostic screen) — no
// longer used for the default display/export/print ordering above.
function parseTransactionNumberValue(numStr) {
  const n = parseInt(String(numStr || "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
function orderByTransactionNumber(list, order) {
  const sorted = list.slice().sort((a, b) => parseTransactionNumberValue(a.transactionNumber) - parseTransactionNumberValue(b.transactionNumber));
  if (order === "newest") sorted.reverse();
  return sorted;
}

// Parses user input (a number or numeric string, possibly with commas) into
// integer centimes. Returns null if it isn't a valid, finite, non-negative
// amount — callers must treat null as a validation failure, never coerce it.
function toCents(input) {
  if (input === null || input === undefined || input === "") return null;
  const cleaned = typeof input === "string" ? input.replace(/,/g, "").trim() : input;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // Round to the nearest centime to absorb harmless binary floating-point
  // noise from the input (e.g. 12670.10 * 100 as JS computes it) — this is
  // the ONE place a float briefly exists, and only long enough to round to
  // an integer immediately.
  return Math.round(n * 100);
}

// ---- Transaction numbering --------------------------------------------------
function formatTransactionNumber(n, padding) {
  return String(n).padStart(padding || DEFAULT_FINANCE_SETTINGS.numberingPadding, "0");
}

// The numbering scope key: numbering is ONE unified sequence per "السنة
// المالية" only — income and expense transactions share the exact same
// 1..N sequence within a financial year (رقم العملية لا علاقة له بنوع
// العملية), and every financial year is numbered independently from every
// other one. Both db.nextFinanceTransactionNumber() (on creation) and
// renumberTransactionsAfterDeletion() (below) must use the exact same key
// so the two stay in sync.
function transactionNumberScopeKey(financialYearId) {
  return `fy::${financialYearId}`;
}

// After a transaction is deleted, its number must not leave a permanent gap
// — every remaining transaction in the SAME financial year (income and
// expense together, in one sequence) is renumbered to a clean, contiguous
// 1..N sequence, preserving the real order the transactions were originally
// entered in. The atomic per-scope counter used for the NEXT new
// transaction in that same financial year (see
// db.nextFinanceTransactionNumber) is reset to N+1 so newly-created
// transactions continue seamlessly right after the renumbered ones.
//
// Ordering is by createdAt (the true order transactions were entered in),
// NOT by the transaction's own current transactionNumber — old numbers may
// come from a previous (buggy) numbering scheme, or already contain gaps,
// so they can't be trusted as the source of truth for order. createdAt is
// stable and reflects reality regardless of what the numbers said before.
//
// This walks and renumbers EVERY financial year present in the ledger (not
// just the one the deletion happened in) — deliberately, so this same
// function also serves as the one-time migration that repairs any
// old/incorrectly-scoped transaction numbers (see db.js getAll()), and so
// calling it is always safe/idempotent regardless of what changed. Mutates
// `data` (and the transaction objects within it) in place; the caller is
// responsible for db.saveAll(data) / persisting.
function renumberTransactionsAfterDeletion(data) {
  const settings = getFinanceSettings(data);
  const list = data.financeTransactions || [];

  const groups = new Map(); // scopeKey -> transaction[]
  list.forEach((t) => {
    const key = transactionNumberScopeKey(t.financialYearId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });

  if (!data.financeSettings || typeof data.financeSettings !== "object") {
    data.financeSettings = { ...DEFAULT_FINANCE_SETTINGS };
  }
  if (!data.financeSettings.transactionCounters || typeof data.financeSettings.transactionCounters !== "object") {
    data.financeSettings.transactionCounters = {};
  }
  // Old (type + financial-year) scoped counters are no longer used by
  // anything — drop them so they don't linger forever in storage.
  data.financeSettings.transactionCounters = {};

  groups.forEach((items, key) => {
    const ordered = items.slice().sort((a, b) => {
      const ca = String(a.createdAt || "");
      const cb = String(b.createdAt || "");
      if (ca !== cb) return ca.localeCompare(cb);
      // Fall back to the previous transactionNumber, then id, so the sort
      // is fully deterministic even for legacy rows sharing a createdAt.
      const na = parseInt(String(a.transactionNumber || "").replace(/\D/g, ""), 10);
      const nb = parseInt(String(b.transactionNumber || "").replace(/\D/g, ""), 10);
      const aNum = Number.isFinite(na) ? na : Infinity;
      const bNum = Number.isFinite(nb) ? nb : Infinity;
      if (aNum !== bNum) return aNum - bNum;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
    ordered.forEach((t, i) => {
      t.transactionNumber = formatTransactionNumber(i + 1, settings.numberingPadding);
    });
    data.financeSettings.transactionCounters[key] = ordered.length + 1;
  });
}

// ---- Date/time -------------------------------------------------------------
// A transaction's time-of-day, kept as a plain "HH:MM" string (not a Date
// object) so it never drifts with the server or browser's timezone — see
// buildOccurredAt() below.
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
function isValidTime(value) {
  return TIME_REGEX.test(String(value || "").trim());
}

// A sortable "YYYY-MM-DDTHH:MM:SS" string combining the transaction's own
// date + time — deliberately NOT converted through `new Date(...).toISOString()`,
// which reinterprets the value in the server/browser's local offset and can
// silently push a transaction entered near midnight onto the wrong day
// (section 17 of the brief: "منع مشاكل اختلاف Timezone"). Plain zero-padded
// strings in this exact shape sort correctly with ordinary string
// comparison, which is all chronological()/withRunningBalance() need.
function buildOccurredAt(dateStr, timeStr) {
  return `${dateStr}T${timeStr}:00`;
}

// ---- Validation -------------------------------------------------------------
// Every rule from برنامج section 21 ("منع الأخطاء المالية"). Returns
// { ok, error } — never throws, so callers can respond with a clean 400.
function validateTransactionInput(input, data, { isUpdate = false, excludeId = null } = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "بيانات العملية غير صحيحة." };

  const type = input.type;
  if (![TRANSACTION_TYPES.INCOME, TRANSACTION_TYPES.EXPENSE].includes(type)) {
    return { ok: false, error: "نوع العملية غير صحيح." };
  }

  const title = String(input.title || "").trim();
  if (!title) return { ok: false, error: "عنوان العملية مطلوب." };

  const cents = toCents(input.amount);
  if (cents === null || cents <= 0) return { ok: false, error: "المبلغ يجب أن يكون رقمًا أكبر من صفر." };

  const date = input.date ? new Date(input.date) : null;
  if (!date || Number.isNaN(date.getTime())) return { ok: false, error: "التاريخ غير صحيح." };
  const dateStr = date.toISOString().slice(0, 10);

  const time = input.time !== undefined && input.time !== "" ? String(input.time).trim() : "00:00";
  if (!isValidTime(time)) return { ok: false, error: "الوقت غير صحيح (الصيغة المطلوبة: 14:35)." };

  // Financial year: required, resolved from the input or (once one is
  // selected/active) falls back to the active financial year. A financial
  // year is immutable once the transaction exists — an update never moves
  // a transaction to a different year (rule: never mix years).
  let financialYearId;
  if (isUpdate) {
    const existing = (data.financeTransactions || []).find((t) => t.id === excludeId);
    financialYearId = existing ? existing.financialYearId : null;
  } else {
    financialYearId = input.financialYearId || getActiveFinancialYearId(data);
  }
  if (!financialYearId) return { ok: false, error: "يجب اختيار سنة مالية نشطة قبل تسجيل أي عملية مالية." };
  const financialYear = getFinancialYear(data, financialYearId);
  if (!financialYear) return { ok: false, error: "السنة المالية المحددة غير موجودة." };
  if (!isUpdate && financialYear.status !== FINANCIAL_YEAR_STATUS.ACTIVE) {
    return { ok: false, error: "هذه السنة المالية معطّلة، لا يمكن إضافة عمليات جديدة إليها." };
  }

  // اللجنة (committee) — the committee/activity the expense was made FOR
  // (e.g. لجنة التحكيم، اللجنة الفنية). Kept on the `categoryId` field name
  // for backward compatibility with existing stored transactions/history —
  // only its meaning/label changed, never its storage key.
  let categoryId = input.categoryId || null;
  if (type === TRANSACTION_TYPES.EXPENSE) {
    if (!categoryId) return { ok: false, error: "اللجنة مطلوبة لعمليات الخروج." };
    const category = (data.financeCategories || []).find((c) => c.id === categoryId);
    if (!category) return { ok: false, error: "اللجنة غير موجودة." };
    if (category.status !== ENTITY_STATUS.ACTIVE) {
      return { ok: false, error: "هذه اللجنة معطّلة ولا يمكن استخدامها في عملية جديدة." };
    }
  } else {
    categoryId = null; // income transactions never carry a committee
  }

  // جهة الصرف (payee) — the entity the money was actually paid TO (e.g.
  // مطعم الشاف، فندق، شركة). Completely separate from اللجنة above: two
  // independent fields, two independent tables, never merged (section
  // "ثامنًا" of the برنامج update).
  let payeeId = input.payeeId || null;
  if (type === TRANSACTION_TYPES.EXPENSE) {
    if (!payeeId) return { ok: false, error: "جهة الصرف مطلوبة لعمليات الخروج." };
    const payee = (data.financePayees || []).find((p) => p.id === payeeId);
    if (!payee) return { ok: false, error: "جهة الصرف غير موجودة." };
    if (payee.status !== ENTITY_STATUS.ACTIVE) {
      return { ok: false, error: "جهة الصرف هذه معطّلة ولا يمكن استخدامها في عملية جديدة." };
    }
  } else {
    payeeId = null; // income transactions never carry a payee
  }

  if (input.attachment && input.attachment.mimetype && !ALLOWED_ATTACHMENT_MIMES.includes(input.attachment.mimetype)) {
    return { ok: false, error: "نوع الملف المرفق غير مدعوم." };
  }

  // Overdraft rule (section 21): an expense may not exceed the currently
  // available balance, if the admin has this rule enabled. Computed against
  // the CURRENT balance of this transaction's own financial year (opening
  // balance + income - expense so far, that year only — never other
  // years), excluding this transaction's own previous amount when editing
  // an existing expense, so raising/lowering an existing expense checks
  // against the balance as it would be with only this edit applied, not
  // double-counting it.
  const settings = getFinanceSettings(data);
  if (type === TRANSACTION_TYPES.EXPENSE && settings.enforceNoOverdraft) {
    let available = computeFinancialYearBalance(data, financialYearId).balanceCents;
    if (isUpdate && excludeId) {
      const prev = (data.financeTransactions || []).find((t) => t.id === excludeId);
      if (prev && prev.type === TRANSACTION_TYPES.EXPENSE) available += prev.amountCents;
      if (prev && prev.type === TRANSACTION_TYPES.INCOME) available -= prev.amountCents;
    }
    if (cents > available) {
      return { ok: false, error: `لا يمكن تسجيل هذا المبلغ لأنه يتجاوز الرصيد المتاح حاليًا في هذه السنة المالية (${formatAmount(available)}).` };
    }
  }

  return {
    ok: true,
    value: {
      type,
      title,
      amountCents: cents,
      date: dateStr,
      time,
      occurredAt: buildOccurredAt(dateStr, time),
      financialYearId,
      categoryId,
      payeeId,
      details: input.details ? String(input.details).trim() : null,
      notes: input.notes ? String(input.notes).trim() : null,
    },
  };
}

// ---- Balance / summary --------------------------------------------------
// The single source of truth for "الرصيد الحالي" — always computed here, in
// the backend, from the full transaction ledger. Never trust a balance sent
// from the client (rule #3/#4 in the brief). `financialYearId` scopes this
// to one financial year (including its opening balance) — pass it whenever
// a financial year is selected/active, which is effectively always now
// that every transaction belongs to one.
function computeBalance(data, { financialYearId } = {}) {
  if (financialYearId) return computeFinancialYearBalance(data, financialYearId);
  const list = data.financeTransactions || [];
  let income = 0;
  let expense = 0;
  list.forEach((t) => {
    if (t.type === TRANSACTION_TYPES.INCOME) income += t.amountCents;
    else expense += t.amountCents;
  });
  return {
    openingBalanceCents: 0,
    totalIncomeCents: income,
    totalExpenseCents: expense,
    balanceCents: income - expense,
    transactionCount: list.length,
  };
}

// Full chronological ordering (oldest → newest, tie-broken by createdAt then
// insertion order) — the only ordering the running "الرصيد" column in the
// official accounts table is allowed to use, regardless of what sort order
// the UI is currently displaying (section 9: "حساب الرصيد التاريخي يجب أن
// يعتمد دائمًا على التسلسل الزمني الفعلي للعمليات"). Orders by the real
// date+time of the transaction itself (occurredAt), never by createdAt —
// editing a transaction's date/time must re-order it here automatically,
// with no separate "re-sort" step needed anywhere else.
function chronological(list) {
  return list.slice().sort((a, b) => {
    const ao = a.occurredAt || buildOccurredAt(a.date, a.time || "00:00");
    const bo = b.occurredAt || buildOccurredAt(b.date, b.time || "00:00");
    if (ao < bo) return -1;
    if (ao > bo) return 1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

// Returns every transaction annotated with runningBalanceCents (the
// official balance immediately after that transaction, following the true
// chronological order, starting from that financial year's OWN opening
// balance) — computed once over the whole year's ledger so it's correct no
// matter which subset gets displayed afterwards. Scoped to one financial
// year at a time; years never share a running balance.
function withRunningBalance(data, financialYearId) {
  const scoped = financialYearId
    ? (data.financeTransactions || []).filter((t) => t.financialYearId === financialYearId)
    : (data.financeTransactions || []);
  const ordered = chronological(scoped);
  const year = financialYearId ? getFinancialYear(data, financialYearId) : null;
  let running = year ? year.openingBalanceCents : 0;
  const map = new Map();
  ordered.forEach((t) => {
    running += t.type === TRANSACTION_TYPES.INCOME ? t.amountCents : -t.amountCents;
    map.set(t.id, running);
  });
  return map;
}

// ---- Listing / filtering / search ----------------------------------------
// Always scoped to a financial year (the one passed in `filters.financialYearId`,
// falling back to whichever is currently active) — no listing/search/filter
// ever mixes two financial years' transactions together.
function listTransactions(data, filters = {}) {
  const financialYearId = filters.financialYearId || getActiveFinancialYearId(data);
  if (!financialYearId) {
    return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1, totalIncomeCents: 0, totalExpenseCents: 0, netCents: 0, financialYearId: null };
  }
  const balanceMap = withRunningBalance(data, financialYearId);
  let list = (data.financeTransactions || [])
    .filter((t) => t.financialYearId === financialYearId)
    .map((t) => ({ ...t, runningBalanceCents: balanceMap.get(t.id) ?? null }));

  const { q, type, categoryId, payeeId, dateFrom, dateTo, amountMin, amountMax, transactionNumber } = filters;

  if (transactionNumber) list = list.filter((t) => t.transactionNumber.includes(String(transactionNumber).trim()));
  if (type && [TRANSACTION_TYPES.INCOME, TRANSACTION_TYPES.EXPENSE].includes(type)) list = list.filter((t) => t.type === type);
  if (categoryId) list = list.filter((t) => t.categoryId === categoryId); // اللجنة
  if (payeeId) list = list.filter((t) => t.payeeId === payeeId); // جهة الصرف
  if (dateFrom) list = list.filter((t) => t.date >= dateFrom);
  if (dateTo) list = list.filter((t) => t.date <= dateTo);
  if (amountMin !== undefined && amountMin !== null && amountMin !== "") {
    const c = toCents(amountMin);
    if (c !== null) list = list.filter((t) => t.amountCents >= c);
  }
  if (amountMax !== undefined && amountMax !== null && amountMax !== "") {
    const c = toCents(amountMax);
    if (c !== null) list = list.filter((t) => t.amountCents <= c);
  }
  if (q) {
    const needle = String(q).trim().toLowerCase();
    list = list.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        t.transactionNumber.includes(needle) ||
        (t.details || "").toLowerCase().includes(needle)
    );
  }

  // ترتيب العمليات حسب التاريخ والوقت (not by رقم العملية — see
  // orderByOccurredAt above), then the purely-positional رقم العملية
  // المعروض is assigned over that final order, BEFORE pagination slices it
  // — so numbering stays continuous (1, 2, 3, ...) across pages regardless
  // of which page/order/filter is currently applied.
  const order = filters.order === "oldest" ? "oldest" : "newest";
  list = withDisplayNumbers(orderByOccurredAt(list, order));

  const totalIncomeCents = list.filter((t) => t.type === TRANSACTION_TYPES.INCOME).reduce((s, t) => s + t.amountCents, 0);
  const totalExpenseCents = list.filter((t) => t.type === TRANSACTION_TYPES.EXPENSE).reduce((s, t) => s + t.amountCents, 0);

  const total = list.length;
  // pageSize "all" bypasses pagination entirely (used internally to build a
  // full, correctly-ordered dataset for printing) — never exposed as a
  // user-facing page-size choice, which stays limited to 5/10/20/50.
  const wantAll = filters.pageSize === "all";
  const page = wantAll ? 1 : Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = wantAll
    ? (total || 1)
    : ([5, 10, 20, 50].includes(parseInt(filters.pageSize, 10)) ? parseInt(filters.pageSize, 10) : 20);
  const start = (page - 1) * pageSize;
  const pageItems = wantAll ? list : list.slice(start, start + pageSize);

  return {
    items: pageItems,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    totalIncomeCents,
    totalExpenseCents,
    netCents: totalIncomeCents - totalExpenseCents,
    financialYearId,
  };
}

// ---- Reports --------------------------------------------------------------
function periodRange(period, custom = {}) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const iso = (d) => d.toISOString().slice(0, 10);
  let from, to;
  switch (period) {
    case "day":
      from = to = iso(now);
      break;
    case "week": {
      const start = startOfDay(now);
      start.setDate(start.getDate() - start.getDay());
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      from = iso(start);
      to = iso(end);
      break;
    }
    case "month":
      from = iso(new Date(now.getFullYear(), now.getMonth(), 1));
      to = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      break;
    case "year":
      from = iso(new Date(now.getFullYear(), 0, 1));
      to = iso(new Date(now.getFullYear(), 11, 31));
      break;
    case "custom":
      from = custom.dateFrom || null;
      to = custom.dateTo || null;
      break;
    default:
      from = null;
      to = null;
  }
  return { from, to };
}

function buildFinancialReport(data, { period, dateFrom, dateTo, financialYearId, order } = {}) {
  const range = period === "custom" || (!period && (dateFrom || dateTo)) ? { from: dateFrom || null, to: dateTo || null } : periodRange(period);
  const fyId = financialYearId || getActiveFinancialYearId(data);
  let list = (data.financeTransactions || []).filter((t) => !fyId || t.financialYearId === fyId);
  if (range.from) list = list.filter((t) => t.date >= range.from);
  if (range.to) list = list.filter((t) => t.date <= range.to);

  const income = list.filter((t) => t.type === TRANSACTION_TYPES.INCOME);
  const expense = list.filter((t) => t.type === TRANSACTION_TYPES.EXPENSE);
  const totalIncomeCents = income.reduce((s, t) => s + t.amountCents, 0);
  const totalExpenseCents = expense.reduce((s, t) => s + t.amountCents, 0);

  // إجمالي المصاريف حسب اللجنة — grouped by categoryId (اللجنة).
  const byCategory = {};
  expense.forEach((t) => {
    const key = t.categoryId || "uncategorized";
    if (!byCategory[key]) byCategory[key] = { categoryId: t.categoryId, count: 0, totalCents: 0 };
    byCategory[key].count += 1;
    byCategory[key].totalCents += t.amountCents;
  });
  const byCategoryList = Object.values(byCategory).map((row) => {
    const cat = (data.financeCategories || []).find((c) => c.id === row.categoryId);
    return { ...row, categoryName: cat ? cat.name : "غير محدد" };
  });

  // إجمالي المصاريف حسب جهة الصرف — grouped by payeeId (جهة الصرف),
  // completely independent from the اللجنة breakdown above (section
  // "ثامنًا"/"تاسعًا" of the برنامج update: never merge the two).
  const byPayee = {};
  expense.forEach((t) => {
    const key = t.payeeId || "unspecified";
    if (!byPayee[key]) byPayee[key] = { payeeId: t.payeeId, count: 0, totalCents: 0 };
    byPayee[key].count += 1;
    byPayee[key].totalCents += t.amountCents;
  });
  const byPayeeList = Object.values(byPayee).map((row) => {
    const payee = (data.financePayees || []).find((p) => p.id === row.payeeId);
    return { ...row, payeeName: payee ? payee.name : "غير محدد" };
  });

  const financialYear = fyId ? getFinancialYear(data, fyId) : null;

  // "فترة التقرير" for display (PDF/Excel/print) — reflects the period the
  // user actually selected. When no explicit from/to was chosen (e.g. the
  // "السنة المالية كاملة" scope), fall back to that financial year's own
  // calendar bounds purely for the printed/exported label — this NEVER
  // changes which transactions were filtered in above.
  const displayRange = { from: range.from || null, to: range.to || null };
  if (!displayRange.from && !displayRange.to && financialYear) {
    displayRange.from = `${financialYear.year}-01-01`;
    displayRange.to = `${financialYear.year}-12-31`;
  }

  const reportOrder = order === "newest" ? "newest" : "oldest";
  return {
    range,
    displayRange,
    order: reportOrder,
    financialYearId: fyId,
    financialYear,
    openingBalanceCents: financialYear ? financialYear.openingBalanceCents : 0,
    totalIncomeCents,
    totalExpenseCents,
    balanceCents: (financialYear ? financialYear.openingBalanceCents : 0) + totalIncomeCents - totalExpenseCents,
    incomeCount: income.length,
    expenseCount: expense.length,
    // ترتيب حسب التاريخ والوقت (not رقم العملية), with a fresh purely-
    // positional رقم العملية المعروض assigned over the final report order —
    // exports/print/on-screen all read this SAME ordered+numbered array, so
    // they can never disagree with each other (section 4/5 of the برنامج
    // update).
    transactions: withDisplayNumbers(orderByOccurredAt(list, reportOrder)),
    byCategory: byCategoryList.sort((a, b) => b.totalCents - a.totalCents),
    byPayee: byPayeeList.sort((a, b) => b.totalCents - a.totalCents),
  };
}

function buildCategoryReport(data, { financialYearId } = {}) {
  const fyId = financialYearId || getActiveFinancialYearId(data);
  const categories = data.financeCategories || [];
  return categories.map((cat) => {
    const txns = (data.financeTransactions || []).filter((t) => t.categoryId === cat.id && (!fyId || t.financialYearId === fyId));
    return {
      categoryId: cat.id,
      name: cat.name,
      status: cat.status,
      count: txns.length,
      totalCents: txns.reduce((s, t) => s + t.amountCents, 0),
    };
  }).sort((a, b) => b.totalCents - a.totalCents);
}

// Same report, but grouped by جهة الصرف (payeeId) instead of اللجنة
// (categoryId) — a fully independent breakdown, never merged with the one
// above.
function buildPayeeReport(data, { financialYearId } = {}) {
  const fyId = financialYearId || getActiveFinancialYearId(data);
  const payees = data.financePayees || [];
  return payees.map((payee) => {
    const txns = (data.financeTransactions || []).filter((t) => t.payeeId === payee.id && (!fyId || t.financialYearId === fyId));
    return {
      payeeId: payee.id,
      name: payee.name,
      status: payee.status,
      count: txns.length,
      totalCents: txns.reduce((s, t) => s + t.amountCents, 0),
    };
  }).sort((a, b) => b.totalCents - a.totalCents);
}

// ---- Chart data (monthly income/expense/balance evolution) ----------------
function buildMonthlySeries(data, { months = 12, financialYearId } = {}) {
  const fyId = financialYearId || getActiveFinancialYearId(data);
  const scoped = fyId ? (data.financeTransactions || []).filter((t) => t.financialYearId === fyId) : (data.financeTransactions || []);
  const ordered = chronological(scoped);
  const buckets = new Map(); // "YYYY-MM" -> { incomeCents, expenseCents }
  ordered.forEach((t) => {
    const key = t.date.slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, { incomeCents: 0, expenseCents: 0 });
    const b = buckets.get(key);
    if (t.type === TRANSACTION_TYPES.INCOME) b.incomeCents += t.amountCents;
    else b.expenseCents += t.amountCents;
  });
  const keys = Array.from(buckets.keys()).sort().slice(-months);
  const financialYear = fyId ? getFinancialYear(data, fyId) : null;
  let running = financialYear ? financialYear.openingBalanceCents : 0;
  // Running balance up to the start of the shown window, so the first
  // shown month's ending balance is still historically accurate.
  Array.from(buckets.keys()).sort().forEach((k) => {
    if (keys.includes(k)) return;
    const b = buckets.get(k);
    running += b.incomeCents - b.expenseCents;
  });
  return keys.map((k) => {
    const b = buckets.get(k);
    running += b.incomeCents - b.expenseCents;
    return { month: k, incomeCents: b.incomeCents, expenseCents: b.expenseCents, balanceCents: running };
  });
}

module.exports = {
  TRANSACTION_TYPES,
  ENTITY_STATUS,
  ALLOWED_ATTACHMENT_MIMES,
  DEFAULT_FINANCE_SETTINGS,
  getFinanceSettings,
  formatAmount,
  formatDateDMY,
  orderByTransactionNumber,
  orderByOccurredAt,
  withDisplayNumbers,
  toCents,
  formatTransactionNumber,
  transactionNumberScopeKey,
  renumberTransactionsAfterDeletion,
  isValidTime,
  buildOccurredAt,
  validateTransactionInput,
  computeBalance,
  chronological,
  withRunningBalance,
  listTransactions,
  buildFinancialReport,
  buildCategoryReport,
  buildPayeeReport,
  buildMonthlySeries,
  uuidv4,
  // Financial years
  FINANCIAL_YEAR_STATUS,
  getActiveFinancialYearId,
  getFinancialYear,
  validateFinancialYearInput,
  computeFinancialYearBalance,
  listFinancialYears,
};
