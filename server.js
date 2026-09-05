// server.js — standalone server for the "النظام المالي" (finance system).
//
// This used to be mounted at /finance inside the referee-platform's single
// server. It is now its own independent project/deployment: its own
// server, its own port, its own login page — but it still points at the
// SAME MongoDB database as the referee-platform project (see the note at
// the top of db.js), so every existing admin/finance_admin/finance_viewer
// account, and every previously-recorded transaction/category/financial
// year, keeps working exactly as before with zero data migration.
//
// Deploy this as a second, separate web service (its own URL/port). Then
// update FINANCE_SYSTEM_URL in the referee-platform project's
// public/app.js to point the admin topbar's "💰 النظام المالي" button here.
//
// NOTE ON LOGIN: the old combined app let an admin already logged into the
// referee platform browse straight into /finance without logging in again,
// because both pages shared one browser origin (and therefore one
// localStorage). Since this is now a different origin/deployment, that
// automatic hand-off no longer happens — admins and finance users log in
// here separately, with the same credentials as before.

const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

const db = require("./db");
const { PORT, ADMIN_USERNAME, ADMIN_PASSWORD } = require("./config");

const authRoutes = require("./routes/auth");
const financeRoutes = require("./routes/finance");

// Same seedAdmin() logic as the referee-platform project (kept here too,
// duplicated on purpose): if this project is ever the FIRST of the two to
// connect to a brand-new, empty database, there still needs to be a way to
// log in — this creates the same default admin account the referee
// platform would have created. On the normal path (referee-platform
// already created the admin account) this is a harmless no-op.
async function seedAdmin() {
  const data = await db.getAll();
  const hasAdmin = data.users.some((u) => u.role === "admin");
  if (!hasAdmin) {
    const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);
    data.users.push({
      id: uuidv4(),
      role: "admin",
      username: ADMIN_USERNAME,
      email: "admin@lwf-eloued.local",
      fullNameAr: "مدير المنصة",
      fullNameLatin: "Administrateur",
      password: hashed,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    });
    await db.saveAll(data);
    console.log(`✔ تم إنشاء حساب الإدارة الافتراضي — اسم المستخدم: ${ADMIN_USERNAME}`);
  }
}

async function main() {
  console.log("⏳ جارِ الاتصال بقاعدة بيانات MongoDB Atlas...");
  try {
    await db.connect();
    console.log("✔ تم الاتصال بقاعدة البيانات بنجاح.");
  } catch (err) {
    console.error("✗ تعذّر الاتصال بقاعدة البيانات:");
    console.error("  " + err.message);
    console.error("\n  تأكد من وجود متغير البيئة MONGODB_URI وأنه يحتوي على رابط اتصال صحيح من MongoDB Atlas (نفس رابط منصة الحكام حتى تبقى البيانات موحّدة).");
    process.exit(1);
  }

  await seedAdmin();

  // Launches Chromium once at startup (not on the first PDF request) so a
  // broken PDF engine shows up immediately in the deploy/runtime logs —
  // exactly where you'd look right after a "تعذر إنشاء ملف PDF" report —
  // instead of only failing silently until someone clicks the PDF button.
  // Runs in the background; it does not block the server from starting.
  (async () => {
    console.log("⏳ جارِ التحقق من محرك توليد PDF (Chromium عبر Puppeteer)...");
    const { checkPdfEngine } = require("./pdfRenderer");
    const result = await checkPdfEngine();
    if (result.ok) {
      console.log("✔ محرك PDF يعمل بشكل سليم.");
    } else {
      console.error("✗ محرك PDF لا يعمل — تصدير PDF سيفشل حتى يُحل هذا:");
      console.error("  " + result.error);
      console.error("  " + result.hint);
      console.error("  (يمكن أيضًا التحقق لاحقًا عبر GET /api/finance/export/pdf/diagnostics بحساب مدير)");
    }
  })();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  // Same no-cache treatment for html/css/js as the referee-platform project
  // (see that project's server.js for the full reasoning) — avoids phones
  // silently serving a stale finance.js/styles.css after a redeploy.
  app.use(express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (/\.(html|css|js)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    }
  }));

  app.use("/api/auth", authRoutes);
  app.use("/api/finance", financeRoutes);

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // Multer / generic error handler
  app.use((err, req, res, next) => {
    if (err) {
      console.error(err);
      return res.status(400).json({ error: err.message || "حدث خطأ غير متوقع." });
    }
    next();
  });

  // Single-page app — every route serves the finance mini-SPA shell.
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "finance.html"));
  });

  app.listen(PORT, () => {
    console.log(`🚀 النظام المالي يعمل على المنفذ ${PORT}`);
    console.log(`   افتح المتصفح على: http://localhost:${PORT}`);
  });

  // ---- Keep-alive self-ping ----------------------------------------------
  // Same reasoning/limits as the referee-platform project's server.js —
  // see that file's comment for the full explanation. Kept here too since
  // this is now its own separately-deployed Render (or similar) service
  // with its own idle timer.
  const KEEP_ALIVE_BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || null;
  if (KEEP_ALIVE_BASE_URL) {
    const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    let pingUrl;
    try {
      pingUrl = new URL("/api/health", KEEP_ALIVE_BASE_URL).toString();
    } catch (e) {
      console.error(`✗ رابط KEEP_ALIVE_URL/RENDER_EXTERNAL_URL غير صالح: ${KEEP_ALIVE_BASE_URL}`);
      pingUrl = null;
    }
    if (pingUrl) {
      const selfPing = () => {
        fetch(pingUrl)
          .then((r) => { if (!r.ok) console.warn(`⚠️ نبضة التنشيط الذاتية رجعت بحالة ${r.status}`); })
          .catch((err) => console.warn(`⚠️ فشلت نبضة التنشيط الذاتية (سيُعاد المحاولة بعد ${KEEP_ALIVE_INTERVAL_MS / 60000} دقيقة): ${err.message}`));
      };
      setInterval(selfPing, KEEP_ALIVE_INTERVAL_MS);
      console.log(`⏰ نبضة التنشيط الذاتية مفعّلة كل ${KEEP_ALIVE_INTERVAL_MS / 60000} دقائق إلى: ${pingUrl}`);
    }
  } else {
    console.log("ℹ️ نبضة التنشيط الذاتية غير مفعّلة محليًا (طبيعي — ستُفعَّل تلقائيًا على Render، أو عيّن KEEP_ALIVE_URL يدويًا لتفعيلها هنا أيضًا).");
  }
}

main();

// Close the shared headless-Chromium instance used for PDF generation
// (pdfRenderer.js) on shutdown, so it doesn't linger as an orphaned
// process when the server restarts/redeploys.
const { closeBrowser } = require("./pdfRenderer");
["SIGTERM", "SIGINT"].forEach((sig) => {
  process.on(sig, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
});
