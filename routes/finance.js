// routes/finance.js — API for the "المالية" (finance) module: income/expense
// transactions, spending categories (جهات الصرف), financial years, reports,
// Excel/PDF export, settings, and finance-scoped user accounts.
//
// RBAC (section 17 of the brief) — enforced here, on the server, on every
// route; the frontend hiding a button is never the actual security
// boundary (rule #5: "لا تسمح للمستخدم بتجاوز الصلاحيات عن طريق API مباشرة"):
//   admin           — مدير النظام: full control (create/edit/delete
//                      everything, manage finance users, categories,
//                      financial years, settings).
//   finance_admin   — المسؤول المالي: add/edit transactions, view, report,
//                      export. Cannot delete transactions, manage users,
//                      categories, financial years, or settings.
//   finance_viewer  — مستخدم للعرض: read-only — view transactions and
//                      reports only.
//
// The platform used to also have a "الموسم الرياضي" (sporting season)
// concept here, fully independent from the "السنة المالية" (financial
// year) system above — it has been removed entirely (backend, database,
// and frontend) in favour of relying on financial years alone. See db.js
// for the one-time migration that drops any stored seasons/season
// references from existing platform data.

const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const { requireAuth, requireAnyRole, requireRole } = require("../middleware/auth");
const { MAX_UPLOAD_MB } = require("../config");
const core = require("../financeCore");
const { FINANCE_ACTIONS, addFinanceAuditEntry, getFinanceAuditLog } = require("../financeAuditCore");
const { buildExcelReport } = require("../financeExcel");
const { buildPdfReport } = require("../financePdf");

const router = express.Router();

const FINANCE_ROLES = ["admin", "finance_admin", "finance_viewer"];
const MANAGE_ROLES = ["admin", "finance_admin"]; // can create/edit transactions
const ADMIN_ONLY = ["admin"]; // delete transactions, manage categories/financial years/users/settings

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!core.ALLOWED_ATTACHMENT_MIMES.includes(file.mimetype)) return cb(new Error("نوع الملف غير مدعوم."));
    cb(null, true);
  },
});

// Every finance route requires a logged-in user who holds one of the three
// finance roles — a referee account (or an admin token that was somehow
// forged without a valid role) never reaches any handler below.
router.use(requireAuth, requireAnyRole(FINANCE_ROLES));

function actorName(req) {
  return req.user.fullNameAr || req.user.username || req.user.id;
}

function toPublicTransaction(t, data) {
  const category = t.categoryId ? (data.financeCategories || []).find((c) => c.id === t.categoryId) : null;
  return {
    ...t,
    amount: t.amountCents / 100,
    amountFormatted: core.formatAmount(t.amountCents),
    runningBalance: t.runningBalanceCents != null ? t.runningBalanceCents / 100 : null,
    runningBalanceFormatted: t.runningBalanceCents != null ? core.formatAmount(t.runningBalanceCents) : null,
    categoryName: category ? category.name : null,
  };
}

function toPublicFinancialYear(y) {
  return {
    ...y,
    openingBalance: y.openingBalanceCents / 100,
    openingBalanceFormatted: core.formatAmount(y.openingBalanceCents),
    totalIncome: y.totalIncomeCents / 100,
    totalIncomeFormatted: core.formatAmount(y.totalIncomeCents),
    totalExpense: y.totalExpenseCents / 100,
    totalExpenseFormatted: core.formatAmount(y.totalExpenseCents),
    balance: y.balanceCents / 100,
    balanceFormatted: core.formatAmount(y.balanceCents),
  };
}

// ============================================================
// Financial years (السنوات المالية) — must exist and one must be active
// before any other financial operation can run (section "أولاً" of the
// brief). Creating/editing/disabling is admin-only; everyone with finance
// access can view the list and see which year is active.
// ============================================================
router.get("/years", async (req, res) => {
  const data = await db.getAll();
  res.json({
    years: core.listFinancialYears(data).map(toPublicFinancialYear),
    activeFinancialYearId: core.getActiveFinancialYearId(data),
  });
});

router.post("/years", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const check = core.validateFinancialYearInput(req.body, data);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const now = new Date().toISOString();
  const year = {
    id: uuidv4(),
    ...check.value,
    status: core.FINANCIAL_YEAR_STATUS.ACTIVE,
    createdAt: now,
    createdBy: req.user.id,
    createdByName: actorName(req),
    updatedAt: now,
  };
  data.financeYears.push(year);
  // A newly-created financial year becomes the active one immediately (per
  // the brief: "بعد إنشاء السنة المالية تصبح السنة المختارة هي السنة
  // المالية النشطة") so the admin can start recording transactions in it
  // right away, with no separate "activate" step required.
  data.financeSettings.activeFinancialYearId = year.id;

  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.CREATE_FINANCIAL_YEAR, entity: "financialYear", entityId: year.id,
    newData: year, summary: `تم إنشاء سنة مالية جديدة: ${year.year} برصيد افتتاحي ${core.formatAmount(year.openingBalanceCents)}، وأصبحت السنة المالية النشطة.`,
  });
  await db.saveAll(data);
  res.status(201).json({ year: toPublicFinancialYear({ ...year, ...core.computeFinancialYearBalance(data, year.id) }), activeFinancialYearId: year.id });
});

router.put("/years/:id", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const year = (data.financeYears || []).find((y) => y.id === req.params.id);
  if (!year) return res.status(404).json({ error: "السنة المالية غير موجودة." });

  const check = core.validateFinancialYearInput(req.body, data, { isUpdate: true, excludeId: year.id });
  if (!check.ok) return res.status(400).json({ error: check.error });
  const before = { ...year };

  year.year = check.value.year;
  if (req.body.openingBalance !== undefined) year.openingBalanceCents = check.value.openingBalanceCents;
  if (req.body.status !== undefined && Object.values(core.FINANCIAL_YEAR_STATUS).includes(req.body.status)) {
    year.status = req.body.status;
  }
  year.updatedAt = new Date().toISOString();

  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.UPDATE_FINANCIAL_YEAR, entity: "financialYear", entityId: year.id,
    oldData: before, newData: year, summary: `تم تعديل السنة المالية ${year.year}.`,
  });
  await db.saveAll(data);
  res.json({ year: toPublicFinancialYear({ ...year, ...core.computeFinancialYearBalance(data, year.id) }) });
});

// Hard delete only allowed when the year has no transactions at all (rule:
// never mix/lose data — a year with any recorded activity must be disabled
// instead, never deleted).
router.delete("/years/:id", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const idx = (data.financeYears || []).findIndex((y) => y.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "السنة المالية غير موجودة." });
  const inUse = (data.financeTransactions || []).some((t) => t.financialYearId === req.params.id);
  if (inUse) return res.status(400).json({ error: "لا يمكن حذف سنة مالية تحتوي على عمليات. قم بتعطيلها بدلاً من ذلك." });
  const [removed] = data.financeYears.splice(idx, 1);
  if (data.financeSettings.activeFinancialYearId === removed.id) data.financeSettings.activeFinancialYearId = null;
  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.DELETE_FINANCIAL_YEAR, entity: "financialYear", entityId: removed.id,
    oldData: removed, summary: `تم حذف السنة المالية ${removed.year}.`,
  });
  await db.saveAll(data);
  res.json({ ok: true });
});

// Switch the active financial year — everything else (transactions list,
// summary, reports, export, print) reads whichever year is active unless a
// specific financialYearId is passed explicitly.
router.post("/years/:id/activate", requireAnyRole(MANAGE_ROLES), async (req, res) => {
  const data = await db.getAll();
  const year = (data.financeYears || []).find((y) => y.id === req.params.id);
  if (!year) return res.status(404).json({ error: "السنة المالية غير موجودة." });
  data.financeSettings.activeFinancialYearId = year.id;
  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.ACTIVATE_FINANCIAL_YEAR, entity: "financialYear", entityId: year.id,
    summary: `تم التبديل إلى السنة المالية ${year.year} كسنة نشطة.`,
  });
  await db.saveAll(data);
  res.json({ activeFinancialYearId: year.id });
});

// ============================================================
// Dashboard summary
// ============================================================
router.get("/summary", async (req, res) => {
  const data = await db.getAll();
  const financialYearId = req.query.financialYearId || core.getActiveFinancialYearId(data);
  if (!financialYearId) return res.json({ noActiveFinancialYear: true });
  const balance = core.computeBalance(data, { financialYearId });
  const monthly = core.buildMonthlySeries(data, { months: 12, financialYearId });
  const recent = core.listTransactions(data, { page: 1, pageSize: 8, order: "newest", financialYearId });
  res.json({
    financialYearId,
    openingBalanceCents: balance.openingBalanceCents,
    openingBalanceFormatted: core.formatAmount(balance.openingBalanceCents),
    balanceCents: balance.balanceCents,
    balanceFormatted: core.formatAmount(balance.balanceCents),
    totalIncomeCents: balance.totalIncomeCents,
    totalIncomeFormatted: core.formatAmount(balance.totalIncomeCents),
    totalExpenseCents: balance.totalExpenseCents,
    totalExpenseFormatted: core.formatAmount(balance.totalExpenseCents),
    transactionCount: balance.transactionCount,
    monthly: monthly.map((m) => ({
      month: m.month,
      income: m.incomeCents / 100,
      expense: m.expenseCents / 100,
      balance: m.balanceCents / 100,
    })),
    recentTransactions: recent.items.map((t) => toPublicTransaction(t, data)),
  });
});

// ============================================================
// Transactions
// ============================================================
router.get("/transactions", async (req, res) => {
  const data = await db.getAll();
  const result = core.listTransactions(data, req.query);
  res.json({
    ...result,
    items: result.items.map((t) => toPublicTransaction(t, data)),
    totalIncomeFormatted: core.formatAmount(result.totalIncomeCents),
    totalExpenseFormatted: core.formatAmount(result.totalExpenseCents),
    netFormatted: core.formatAmount(result.netCents),
  });
});

router.get("/transactions/:id", async (req, res) => {
  const data = await db.getAll();
  const t = (data.financeTransactions || []).find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "العملية غير موجودة." });
  const balanceMap = core.withRunningBalance(data, t.financialYearId);
  res.json({ transaction: toPublicTransaction({ ...t, runningBalanceCents: balanceMap.get(t.id) }, data) });
});

router.post("/transactions", requireAnyRole(MANAGE_ROLES), upload.single("attachment"), async (req, res) => {
  const data = await db.getAll();
  const check = core.validateTransactionInput(req.body, data);
  if (!check.ok) return res.status(400).json({ error: check.error });

  let attachment = null;
  if (req.file) {
    if (!cloudinaryLib.isConfigured()) {
      return res.status(500).json({ error: "لم يتم إعداد تخزين الملفات (Cloudinary) على الخادم." });
    }
    try {
      const uploadResult = await cloudinaryLib.uploadBuffer(req.file.buffer, {
        public_id: `finance_${uuidv4().slice(0, 10)}`,
        resource_type: "auto",
        folder: "lwf-finance",
      });
      attachment = {
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        url: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        resourceType: uploadResult.resource_type,
        uploadedAt: new Date().toISOString(),
        uploadedBy: actorName(req),
      };
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "تعذّر رفع الفاتورة إلى خدمة التخزين. حاول مرة أخرى." });
    }
  }

  // Numbering is ONE unified sequence per financial year — income and
  // expense transactions share the same 1..N sequence (see financeCore.js:
  // transactionNumberScopeKey).
  const scopeKey = core.transactionNumberScopeKey(check.value.financialYearId);
  const seq = await db.nextFinanceTransactionNumber(scopeKey);
  const settings = core.getFinanceSettings(data);
  const now = new Date().toISOString();
  const transaction = {
    id: uuidv4(),
    transactionNumber: core.formatTransactionNumber(seq, settings.numberingPadding),
    ...check.value,
    attachment,
    createdBy: req.user.id,
    createdByName: actorName(req),
    updatedBy: null,
    updatedByName: null,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: "تم إنشاء العملية", by: req.user.id, byName: actorName(req) }],
  };

  // Re-fetch to avoid clobbering the atomically-incremented counter with a
  // stale in-memory copy of financeSettings from the read above.
  const fresh = await db.getAll();
  fresh.financeTransactions.push(transaction);
  addFinanceAuditEntry(fresh, {
    userId: req.user.id,
    userName: actorName(req),
    userRole: req.user.role,
    action: FINANCE_ACTIONS.CREATE_TRANSACTION,
    entity: "transaction",
    entityId: transaction.id,
    newData: transaction,
    summary: `تمت إضافة عملية ${transaction.type === "income" ? "دخول" : "خروج"} رقم ${transaction.transactionNumber} بقيمة ${core.formatAmount(transaction.amountCents)}.`,
  });
  await db.saveAll(fresh);

  res.status(201).json({ transaction: toPublicTransaction(transaction, fresh) });
});

router.put("/transactions/:id", requireAnyRole(MANAGE_ROLES), upload.single("attachment"), async (req, res) => {
  const data = await db.getAll();
  const idx = (data.financeTransactions || []).findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "العملية غير موجودة." });
  const existing = data.financeTransactions[idx];

  const check = core.validateTransactionInput(req.body, data, { isUpdate: true, excludeId: existing.id });
  if (!check.ok) return res.status(400).json({ error: check.error });

  let attachment = existing.attachment || null;
  if (req.file) {
    if (!cloudinaryLib.isConfigured()) {
      return res.status(500).json({ error: "لم يتم إعداد تخزين الملفات (Cloudinary) على الخادم." });
    }
    try {
      const uploadResult = await cloudinaryLib.uploadBuffer(req.file.buffer, {
        public_id: `finance_${uuidv4().slice(0, 10)}`,
        resource_type: "auto",
        folder: "lwf-finance",
      });
      if (existing.attachment && existing.attachment.publicId) {
        await cloudinaryLib.destroyAsset(existing.attachment.publicId, existing.attachment.resourceType);
      }
      attachment = {
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        url: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        resourceType: uploadResult.resource_type,
        uploadedAt: new Date().toISOString(),
        uploadedBy: actorName(req),
      };
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: "تعذّر رفع الفاتورة إلى خدمة التخزين. حاول مرة أخرى." });
    }
  } else if (req.body.removeAttachment === "true" || req.body.removeAttachment === true) {
    if (existing.attachment && existing.attachment.publicId) {
      await cloudinaryLib.destroyAsset(existing.attachment.publicId, existing.attachment.resourceType);
    }
    attachment = null;
  }

  const now = new Date().toISOString();
  const before = { ...existing };
  const updated = {
    ...existing,
    ...check.value,
    attachment,
    updatedBy: req.user.id,
    updatedByName: actorName(req),
    updatedAt: now,
    history: [
      ...(existing.history || []),
      {
        at: now,
        event:
          existing.amountCents !== check.value.amountCents
            ? `تم تعديل العملية من ${core.formatAmount(existing.amountCents)} إلى ${core.formatAmount(check.value.amountCents)}`
            : "تم تعديل بيانات العملية",
        by: req.user.id,
        byName: actorName(req),
      },
    ],
  };
  data.financeTransactions[idx] = updated;

  addFinanceAuditEntry(data, {
    userId: req.user.id,
    userName: actorName(req),
    userRole: req.user.role,
    action: FINANCE_ACTIONS.UPDATE_TRANSACTION,
    entity: "transaction",
    entityId: updated.id,
    oldData: before,
    newData: updated,
    summary: `تم تعديل العملية رقم ${updated.transactionNumber}.`,
  });
  await db.saveAll(data);

  res.json({ transaction: toPublicTransaction(updated, data) });
});

// Deleting a financial transaction is restricted to the system admin only
// (المسؤول المالي is not listed with a delete permission in section 17).
router.delete("/transactions/:id", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const idx = (data.financeTransactions || []).findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "العملية غير موجودة." });
  const [removed] = data.financeTransactions.splice(idx, 1);

  if (removed.attachment && removed.attachment.publicId) {
    await cloudinaryLib.destroyAsset(removed.attachment.publicId, removed.attachment.resourceType);
  }

  addFinanceAuditEntry(data, {
    userId: req.user.id,
    userName: actorName(req),
    userRole: req.user.role,
    action: FINANCE_ACTIONS.DELETE_TRANSACTION,
    entity: "transaction",
    entityId: removed.id,
    oldData: removed,
    summary: `تم حذف العملية رقم ${removed.transactionNumber} بقيمة ${core.formatAmount(removed.amountCents)}.`,
  });
  // Close the gap left by the deleted number — every remaining transaction
  // is renumbered to a clean, contiguous sequence starting at 1 (see
  // financeCore.js: renumberTransactionsAfterDeletion).
  core.renumberTransactionsAfterDeletion(data);
  await db.saveAll(data);
  res.json({ ok: true });
});

// ============================================================
// Spending categories (جهات الصرف)
// ============================================================
router.get("/categories", async (req, res) => {
  const data = await db.getAll();
  res.json({ categories: data.financeCategories || [] });
});

router.post("/categories", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ error: "اسم جهة الصرف مطلوب." });
  if ((data.financeCategories || []).some((c) => c.name === name)) {
    return res.status(400).json({ error: "توجد جهة صرف بنفس الاسم." });
  }
  const now = new Date().toISOString();
  const category = {
    id: uuidv4(),
    name,
    description: (req.body.description || "").trim() || null,
    status: core.ENTITY_STATUS.ACTIVE,
    createdAt: now,
    updatedAt: now,
  };
  data.financeCategories.push(category);
  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.CREATE_CATEGORY, entity: "category", entityId: category.id,
    newData: category, summary: `تمت إضافة جهة صرف جديدة: ${name}.`,
  });
  await db.saveAll(data);
  res.status(201).json({ category });
});

router.put("/categories/:id", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const cat = (data.financeCategories || []).find((c) => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: "جهة الصرف غير موجودة." });
  const before = { ...cat };

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "اسم جهة الصرف مطلوب." });
    cat.name = name;
  }
  if (req.body.description !== undefined) cat.description = String(req.body.description).trim() || null;
  if (req.body.status !== undefined && [core.ENTITY_STATUS.ACTIVE, core.ENTITY_STATUS.DISABLED].includes(req.body.status)) {
    cat.status = req.body.status;
  }
  cat.updatedAt = new Date().toISOString();

  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: cat.status === core.ENTITY_STATUS.DISABLED && before.status !== cat.status ? FINANCE_ACTIONS.DISABLE_CATEGORY : FINANCE_ACTIONS.UPDATE_CATEGORY,
    entity: "category", entityId: cat.id, oldData: before, newData: cat,
    summary: `تم تعديل جهة الصرف: ${cat.name}.`,
  });
  await db.saveAll(data);
  res.json({ category: cat });
});

// Hard delete is only allowed when the category has never been used by any
// transaction (section 6: "لا تحذف جهة صرف مرتبطة بعمليات مالية، بل قم
// بتعطيلها"). Otherwise the client should PUT status=disabled instead.
router.delete("/categories/:id", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const idx = (data.financeCategories || []).findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "جهة الصرف غير موجودة." });
  const inUse = (data.financeTransactions || []).some((t) => t.categoryId === req.params.id);
  if (inUse) {
    return res.status(400).json({ error: "لا يمكن حذف جهة صرف مرتبطة بعمليات مالية. قم بتعطيلها بدلاً من ذلك." });
  }
  const [removed] = data.financeCategories.splice(idx, 1);
  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.DELETE_CATEGORY, entity: "category", entityId: removed.id,
    oldData: removed, summary: `تم حذف جهة الصرف: ${removed.name}.`,
  });
  await db.saveAll(data);
  res.json({ ok: true });
});

// ============================================================
// Reports
// ============================================================
router.get("/reports/financial", async (req, res) => {
  const data = await db.getAll();
  const report = core.buildFinancialReport(data, req.query);
  res.json({
    ...report,
    totalIncomeFormatted: core.formatAmount(report.totalIncomeCents),
    totalExpenseFormatted: core.formatAmount(report.totalExpenseCents),
    balanceFormatted: core.formatAmount(report.balanceCents),
    transactions: report.transactions.map((t) => toPublicTransaction(t, data)),
    byCategory: report.byCategory.map((c) => ({ ...c, totalFormatted: core.formatAmount(c.totalCents) })),
  });
});

router.get("/reports/by-category", async (req, res) => {
  const data = await db.getAll();
  const report = core.buildCategoryReport(data);
  res.json({ categories: report.map((c) => ({ ...c, totalFormatted: core.formatAmount(c.totalCents) })) });
});

// ============================================================
// Exports
// ============================================================
router.get("/export/excel", async (req, res) => {
  const data = await db.getAll();
  const report = core.buildFinancialReport(data, req.query);
  const settings = core.getFinanceSettings(data);
  const balanceMap = core.withRunningBalance(data, report.financialYearId);
  try {
    const buffer = await buildExcelReport({
      data, settings, query: req.query,
      report: { ...report, transactions: report.transactions.map((t) => toPublicTransaction({ ...t, runningBalanceCents: balanceMap.get(t.id) }, data)) },
    });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="finance-report-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "تعذّر إنشاء ملف Excel." });
  }
});

// ---- Diagnostics: launches Chromium and renders a trivial PDF, without
// touching any report data. Hit this directly when "تعذر إنشاء ملف PDF"
// shows up in the export button — it reports the *actual* underlying
// error and an Arabic hint for it, instead of the generic message the
// export button itself has to show. Admin-only, like the rest of this
// router (see requireAuth/requireRole above). ----
router.get("/export/pdf/diagnostics", async (req, res) => {
  const { checkPdfEngine } = require("../pdfRenderer");
  const result = await checkPdfEngine();
  res.status(result.ok ? 200 : 500).json(result);
});

router.get("/export/pdf", async (req, res) => {
  const data = await db.getAll();
  const report = core.buildFinancialReport(data, req.query);
  const settings = core.getFinanceSettings(data);
  const balanceMap = core.withRunningBalance(data, report.financialYearId);
  try {
    const buffer = await buildPdfReport({
      data, settings, query: req.query,
      report: { ...report, transactions: report.transactions.map((t) => toPublicTransaction({ ...t, runningBalanceCents: balanceMap.get(t.id) }, data)) },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="finance-report-${Date.now()}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "تعذّر إنشاء ملف PDF." });
  }
});

// ============================================================
// Settings (اسم الرابطة، الشعار، الترقيم، منع تجاوز الرصيد...)
// ============================================================
router.get("/settings", async (req, res) => {
  const data = await db.getAll();
  res.json({ settings: core.getFinanceSettings(data) });
});

router.put("/settings", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const before = core.getFinanceSettings(data);
  const patch = req.body || {};
  const next = { ...before };
  ["ligueNameAr", "ligueNameFr", "logoUrl"].forEach((k) => { if (patch[k] !== undefined) next[k] = String(patch[k] || "").trim() || null; });
  if (patch.currency !== undefined) next.currency = String(patch.currency).trim() || "DZD";
  if (patch.numberingPadding !== undefined) {
    const p = parseInt(patch.numberingPadding, 10);
    if (Number.isFinite(p) && p >= 4 && p <= 10) next.numberingPadding = p;
  }
  if (patch.enforceNoOverdraft !== undefined) next.enforceNoOverdraft = Boolean(patch.enforceNoOverdraft === true || patch.enforceNoOverdraft === "true");
  data.financeSettings = next;

  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.UPDATE_SETTINGS, entity: "settings",
    oldData: before, newData: next, summary: "تم تعديل إعدادات النظام المالي.",
  });
  await db.saveAll(data);
  res.json({ settings: next });
});

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
router.post("/settings/logo", requireAnyRole(ADMIN_ONLY), logoUpload.single("logo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لم يتم إرفاق ملف." });
  if (!["image/png", "image/jpeg", "image/webp"].includes(req.file.mimetype)) {
    return res.status(400).json({ error: "الشعار يجب أن يكون صورة (PNG/JPEG/WEBP)." });
  }
  if (!cloudinaryLib.isConfigured()) return res.status(500).json({ error: "لم يتم إعداد تخزين الملفات (Cloudinary) على الخادم." });
  const data = await db.getAll();
  try {
    const uploadResult = await cloudinaryLib.uploadBuffer(req.file.buffer, { public_id: `finance_logo_${uuidv4().slice(0, 8)}`, folder: "lwf-finance", resource_type: "image" });
    data.financeSettings.logoUrl = uploadResult.secure_url;
    await db.saveAll(data);
    res.json({ logoUrl: uploadResult.secure_url });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "تعذّر رفع الشعار." });
  }
});

// ============================================================
// Finance-scoped user accounts (مدير النظام / المسؤول المالي / مستخدم للعرض)
// ============================================================
const bcrypt = require("bcryptjs");

router.get("/users", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const users = (data.users || [])
    .filter((u) => FINANCE_ROLES.includes(u.role))
    .map((u) => ({ id: u.id, username: u.username, fullNameAr: u.fullNameAr, role: u.role, status: u.status || "active", createdAt: u.createdAt }));
  res.json({ users });
});

router.post("/users", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const { username, password, fullNameAr, role } = req.body || {};
  if (!username || !password || !fullNameAr) return res.status(400).json({ error: "جميع الحقول مطلوبة." });
  if (!["finance_admin", "finance_viewer"].includes(role)) return res.status(400).json({ error: "دور غير صحيح." });
  if (data.users.some((u) => u.username === username)) return res.status(400).json({ error: "اسم المستخدم مستخدم بالفعل." });
  if (String(password).length < 6) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل." });

  const hashed = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(), role, username, fullNameAr, password: hashed,
    status: "active", createdAt: new Date().toISOString(), lastSeenAt: null,
  };
  data.users.push(user);
  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.CREATE_FINANCE_USER, entity: "financeUser", entityId: user.id,
    newData: { username, fullNameAr, role }, summary: `تمت إضافة مستخدم مالي جديد: ${fullNameAr} (${role}).`,
  });
  await db.saveAll(data);
  res.status(201).json({ user: { id: user.id, username: user.username, fullNameAr: user.fullNameAr, role: user.role, status: user.status } });
});

router.put("/users/:id", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const user = (data.users || []).find((u) => u.id === req.params.id && FINANCE_ROLES.includes(u.role) && u.role !== "admin");
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
  const before = { username: user.username, fullNameAr: user.fullNameAr, role: user.role, status: user.status };

  if (req.body.fullNameAr !== undefined) user.fullNameAr = String(req.body.fullNameAr).trim() || user.fullNameAr;
  if (req.body.username !== undefined) {
    const v = String(req.body.username).trim();
    if (v && v !== user.username) {
      const taken = data.users.some((u) => u.id !== user.id && u.username.toLowerCase() === v.toLowerCase());
      if (taken) return res.status(400).json({ error: "اسم المستخدم مستخدم بالفعل." });
      user.username = v;
    }
  }
  if (req.body.role !== undefined && ["finance_admin", "finance_viewer"].includes(req.body.role)) user.role = req.body.role;
  if (req.body.status !== undefined && ["active", "disabled"].includes(req.body.status)) user.status = req.body.status;
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل." });
    user.password = await bcrypt.hash(req.body.password, 10);
  }

  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: user.status === "disabled" && before.status !== "disabled" ? FINANCE_ACTIONS.DISABLE_FINANCE_USER : FINANCE_ACTIONS.UPDATE_FINANCE_USER,
    entity: "financeUser", entityId: user.id, oldData: before,
    newData: { username: user.username, fullNameAr: user.fullNameAr, role: user.role, status: user.status },
    summary: `تم تعديل المستخدم المالي: ${user.fullNameAr}.`,
  });
  await db.saveAll(data);
  res.json({ user: { id: user.id, username: user.username, fullNameAr: user.fullNameAr, role: user.role, status: user.status } });
});

// A finance user is only ever hard-deletable if they never actually did
// anything in the finance system (section 6: عام edit/delete/disable
// pattern) — otherwise their name is needed to keep the audit log
// (createdByName/userName fields already snapshotted per-entry)
// meaningful, so an admin with any history should be disabled instead.
router.delete("/users/:id", requireAnyRole(ADMIN_ONLY), async (req, res) => {
  const data = await db.getAll();
  const idx = (data.users || []).findIndex((u) => u.id === req.params.id && FINANCE_ROLES.includes(u.role) && u.role !== "admin");
  if (idx === -1) return res.status(404).json({ error: "المستخدم غير موجود." });
  const user = data.users[idx];
  const hasHistory = (data.financeAuditLog || []).some((e) => e.userId === user.id)
    || (data.financeTransactions || []).some((t) => t.createdBy === user.id);
  if (hasHistory) return res.status(400).json({ error: "لا يمكن حذف مستخدم له سجل عمليات في النظام المالي. قم بتعطيله بدلاً من ذلك." });

  data.users.splice(idx, 1);
  addFinanceAuditEntry(data, {
    userId: req.user.id, userName: actorName(req), userRole: req.user.role,
    action: FINANCE_ACTIONS.DELETE_FINANCE_USER, entity: "financeUser", entityId: user.id,
    oldData: { username: user.username, fullNameAr: user.fullNameAr, role: user.role },
    summary: `تم حذف المستخدم المالي: ${user.fullNameAr}.`,
  });
  await db.saveAll(data);
  res.json({ ok: true });
});

// ============================================================
// Audit log (سجل التدقيق) — admin and finance_admin can read; never
// editable or deletable through the API by design (rule: "ولا يستطيع
// المستخدم العادي حذف سجل التدقيق" — there is in fact no delete route at
// all here, for anyone, including admin).
// ============================================================
router.get("/audit-logs", requireAnyRole(["admin", "finance_admin"]), async (req, res) => {
  const data = await db.getAll();
  const log = getFinanceAuditLog(data, req.query);
  res.json({ log });
});

module.exports = router;
