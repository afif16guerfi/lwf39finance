// pdfRenderer.js — shared HTML → PDF engine for the whole platform.
//
// WHY THIS FILE EXISTS (read before touching financePdf.js or any future
// PDF-producing module):
//
// pdfkit (the library financePdf.js used to call directly) has no OpenType
// shaping engine — no HarfHuzz/GSUB, no bidi algorithm. It draws exactly
// the glyph you hand it, one at a time, in the order you hand it. Arabic
// text is contextual (a letter's shape depends on its neighbours) and
// right-to-left, so pdfkit fed plain Arabic produces disconnected,
// wrong-direction letters. The previous fix (arabicShape.js) tried to
// pre-shape and pre-reorder the text in JS before handing it to pdfkit —
// that is fragile (custom bidi implementation, font-specific glyph
// tables) and never fully matched real text layout, especially for mixed
// Arabic/Latin/number runs.
//
// The reliable fix is to stop asking pdfkit to lay out Arabic at all, and
// instead let an actual browser engine do it — the same engine that
// already renders the platform's Arabic UI and its "طباعة / تنزيل PDF"
// (window.print()) pages correctly. Puppeteer drives headless Chromium:
// we build a normal HTML document with dir="rtl", a real embedded Arabic
// font, and Chromium's own text shaping (which every browser relies on)
// takes care of letter joining, bidi reordering, and mixed-direction
// numbers automatically — no custom shaping code, no glyph tables to keep
// in sync.
//
// Any module that needs to produce a PDF should build an HTML string
// (see financePdf.js for the reference pattern) and call
// renderHtmlToPdf() below rather than reaching for pdfkit.

const fs = require("fs");
const path = require("path");

// Some hosts (Render is the confirmed case here) build the app in one
// place but only actually deploy/persist a subset of the filesystem to
// the running instance — specifically the project directory itself, NOT
// unrelated paths outside it like $HOME/.cache. Puppeteer's default
// download location for Chrome is $HOME/.cache/puppeteer, which is
// exactly outside that persisted subset — so Chrome gets downloaded
// successfully during the build, then is simply gone by the time the
// server actually starts ("Could not find Chrome" even though the build
// logs showed no error). The fix used on both ends of the install: this
// file defaults PUPPETEER_CACHE_DIR to a path INSIDE this project
// directory (unless the hosting platform already set its own value, which
// is always respected instead), and package.json's "postinstall" script
// downloads Chrome to that same project-local path during npm install —
// so the browser that gets downloaded is the one still there when the
// server launches it, with no manual per-host environment-variable setup
// required. This must run before requiring "puppeteer" below, since that
// require is what reads this variable to decide where to look.
if (!process.env.PUPPETEER_CACHE_DIR) {
  process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, ".cache", "puppeteer");
}
const puppeteer = require("puppeteer");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

// CONFIRMED ON RENDER (2026): the theory above — that the project directory
// survives between build and runtime while $HOME does not — turned out to
// be incomplete. Real production logs showed the build step downloading
// Chrome to this exact PUPPETEER_CACHE_DIR with zero errors ("postinstall"
// completing cleanly, "Build successful"), and the *same* path still coming
// up empty moments later when the freshly deployed instance started and
// tried to launch it. Render's native (non-Docker) deploys build in one
// place, then compress/upload/redeploy that build as a separate step
// ("Uploading build...", "Deploying...") — and whatever that packaging step
// does, this project-local .cache/puppeteer directory does not reliably
// survive it. Waiting for a proper fix upstream isn't reliable, so instead
// this makes Chrome self-installing at runtime: before ever launching the
// browser, check whether the executable Puppeteer expects is actually on
// disk *right now, in this running instance* — not "was it downloaded at
// some point during the build" — and download it on the spot if not. That
// guarantees the download happens on the exact filesystem that will use it,
// which sidesteps the build/runtime split entirely. It costs a one-time
// delay (Chrome is roughly 150-200MB) the first time a fresh instance
// serves a PDF after a deploy or restart, but turns a hard failure that
// needed a manual "clear build cache" redeploy into a self-healing one.
// The existing package.json "postinstall" step is left in place too — on
// hosts where build and runtime *do* share a disk, it means Chrome is
// already there and this check below is an instant no-op.
const PUPPETEER_CLI_PATH = require.resolve("puppeteer/lib/cjs/puppeteer/node/cli.js");
let chromeEnsuredPromise = null;
function ensureChromeInstalled() {
  if (!chromeEnsuredPromise) {
    chromeEnsuredPromise = (async () => {
      let executablePath = null;
      try {
        executablePath = puppeteer.executablePath();
      } catch (e) {
        executablePath = null; // computing the expected path itself failed — fall through to installing anyway
      }
      if (executablePath && fs.existsSync(executablePath)) {
        return; // already present on this instance's disk — the normal case once a host is warmed up
      }
      console.log("⏳ لم يُعثر على Chrome في هذا الخادم — يجري تنزيله الآن قبل أول عملية تصدير PDF (قد يستغرق نحو دقيقة)...");
      // Real production case (Render, 2026): the build's copy of the browser
      // folder can survive the deploy as an empty/partial shell — the
      // directory itself is there but the actual chrome binary inside it is
      // not. @puppeteer/browsers' installer treats "the version folder
      // already exists" as "already installed" and, on finding the
      // executable missing inside it, throws instead of re-downloading —
      // so on a host with this exact corruption, every single install
      // attempt fails forever with "the browser folder exists but the
      // executable is missing", even though a plain retry would fix it.
      // Clear out that stale folder first so the installer is forced to do
      // a full, real download+unpack instead of trusting a broken leftover.
      if (executablePath) {
        const staleBrowserDir = path.dirname(path.dirname(executablePath));
        if (fs.existsSync(staleBrowserDir) && !fs.existsSync(executablePath)) {
          try {
            fs.rmSync(staleBrowserDir, { recursive: true, force: true });
            console.log(`🧹 حذف نسخة Chrome غير مكتملة من نشر سابق: ${staleBrowserDir}`);
          } catch (e) {
            console.error(`✗ تعذّر حذف مجلد Chrome التالف (${staleBrowserDir}) قبل إعادة التنزيل:`);
            console.error(e);
            // Keep going anyway — the install attempt below will surface its
            // own clear error if the stale folder really is what blocks it.
          }
        }
      }
      try {
        await execFileAsync(
          process.execPath,
          [PUPPETEER_CLI_PATH, "browsers", "install", "chrome"],
          { cwd: __dirname, env: process.env, maxBuffer: 1024 * 1024 * 20 }
        );
        console.log("✔ تم تنزيل Chrome بنجاح، محرك PDF جاهز الآن.");
      } catch (e) {
        // Don't cache a rejected promise forever — a transient network hiccup
        // during this on-demand install shouldn't permanently break PDF
        // export for the rest of the process's lifetime; let the next
        // request try again.
        chromeEnsuredPromise = null;
        console.error("✗ فشل تنزيل Chrome عند بدء التشغيل:");
        console.error(e);
        throw e;
      }
    })();
  }
  return chromeEnsuredPromise;
}

const FONT_REGULAR = path.join(__dirname, "assets", "fonts", "Tajawal-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "assets", "fonts", "Tajawal-Bold.ttf");

let fontFaceCssCache = null;
// Embeds the bundled Tajawal font (Arabic + Latin, one file covers both
// scripts and digits) directly in the page as base64 data URIs. This is
// deliberate: it means PDF generation never depends on which fonts happen
// to be installed on the server's OS — the exact font is shipped with the
// document every time, so the result is identical on every machine.
function fontFaceCss() {
  if (fontFaceCssCache) return fontFaceCssCache;
  const parts = [];
  if (fs.existsSync(FONT_REGULAR)) {
    const b64 = fs.readFileSync(FONT_REGULAR).toString("base64");
    parts.push(`@font-face{font-family:"Tajawal";src:url(data:font/ttf;base64,${b64}) format("truetype");font-weight:400;font-style:normal;font-display:block;}`);
  }
  if (fs.existsSync(FONT_BOLD)) {
    const b64 = fs.readFileSync(FONT_BOLD).toString("base64");
    parts.push(`@font-face{font-family:"Tajawal";src:url(data:font/ttf;base64,${b64}) format("truetype");font-weight:700;font-style:normal;font-display:block;}`);
  }
  fontFaceCssCache = parts.join("\n");
  return fontFaceCssCache;
}

// A single headless Chromium instance is reused across requests (starting
// it up takes real time) — it's lazily launched on first use and kept
// alive for the life of the server process.
//
// The extra flags beyond --no-sandbox exist because this runs inside a
// containerized host (Render, Docker, etc.) where the defaults commonly
// fail: --disable-dev-shm-usage avoids Chromium crashing on the tiny
// /dev/shm containers give by default, and --disable-gpu avoids GPU-related
// startup failures on machines with no real GPU. If PUPPETEER_EXECUTABLE_PATH
// is set (e.g. pointing at a Chromium already installed on the host instead
// of the one Puppeteer downloads itself), Puppeteer picks it up
// automatically — nothing else to configure here.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = ensureChromeInstalled().then(() => puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    }).catch((e) => {
      browserPromise = null; // allow retrying on the next call instead of staying broken forever
      // Logged in full here (not just re-thrown) because this is the one
      // place that actually knows this was a *launch* failure specifically
      // — by the time it reaches routes/finance.js's catch block, that
      // context is easy to lose in a generic "تعذر إنشاء ملف PDF" log line.
      console.error("✗ فشل تشغيل Chromium (Puppeteer) — راجع الرسالة أدناه لمعرفة السبب الدقيق:");
      console.error(e);
      throw e;
    })).catch((e) => {
      browserPromise = null; // also reset on an ensureChromeInstalled() failure, not just a launch() failure
      throw e;
    });
  }
  return browserPromise;
}

// Runs a minimal end-to-end check (launch Chromium → render one page → make
// a tiny PDF) without needing any report data, and reports success/failure
// with the real underlying error message. Meant to be hit directly — see
// GET /api/finance/export/pdf/diagnostics in routes/finance.js — so a
// "تعذر إنشاء ملف PDF" failure can be diagnosed in one request instead of
// digging through server logs.
async function checkPdfEngine() {
  try {
    const buffer = await renderHtmlToPdf("<div>تحقق</div>", { format: "A4" });
    return { ok: true, pdfBytes: buffer.length };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      hint: pdfEngineFailureHint(e),
    };
  }
}

// Turns the raw Puppeteer/Chromium error into an actionable Arabic hint —
// the exact wording of these errors is stable enough across Puppeteer
// versions to pattern-match reliably, and each one maps to a genuinely
// different fix.
function pdfEngineFailureHint(e) {
  const msg = String((e && e.message) || e || "");
  if (/Could not find (Chrome|Chromium)|Chromium revision is not downloaded/i.test(msg)) {
    return "لم يُعثر على Chrome في مسار التخزين المؤقت (PUPPETEER_CACHE_DIR). هذا الإصدار يضبط هذا المسار تلقائيًا داخل مجلد المشروع نفسه (وأضاف postinstall في package.json يُنزّل Chrome لنفس المسار عند npm install) — لكن هذا يسري فقط بدءًا من أول تثبيت (npm install) يُنفَّذ بعد رفع هذا التحديث. الحل: أعد النشر مع تفريغ ذاكرة البناء المؤقتة بالكامل (\"Clear build cache & deploy\" إن كنت تستخدم Render، أو ما يعادلها في استضافتك) حتى تُعاد خطوتا npm install وpostinstall من الصفر ويُنزَّل Chrome داخل مجلد المشروع في المكان الصحيح. إعادة نشر عادية بدون تفريغ الكاش قد لا تكفي لأن npm قد يتخطى postinstall إن اعتبر الحزم مثبَّتة أصلاً.";
  }
  if (/error while loading shared libraries|libnss3|libatk|libgbm|libasound/i.test(msg)) {
    return "النظام الأساسي للخادم ينقصه بعض مكتبات النظام التي يحتاجها Chromium (مثل libnss3/libatk/libgbm/libasound). هذه مشكلة شائعة على استضافات تستخدم صورة Linux مصغّرة (Alpine أو صورة Docker خفيفة) — يلزم تثبيت مكتبات Chromium الأساسية على مستوى النظام (على Debian/Ubuntu: `apt-get install -y chromium` أو الحزم المذكورة في رسالة الخطأ)، أو التحويل لصورة Docker تحتويها مسبقًا (مثل صورة Puppeteer الرسمية).";
  }
  if (/Timed out|timeout/i.test(msg)) {
    return "انتهت مهلة تشغيل Chromium أو تحميل الصفحة — غالبًا يعني هذا أن الخادم يعاني من ضغط على الذاكرة/المعالج (شائع على خطط الاستضافة المجانية/الصغيرة). جرّب زيادة موارد الخادم، أو تحقق من عدم وجود عدة عمليات Chromium عالقة من محاولات سابقة.";
  }
  if (/Protocol error|Target closed|Navigation failed/i.test(msg)) {
    return "أُغلقت صفحة Chromium أو انهارت أثناء التوليد — غالبًا بسبب نفاد الذاكرة على الخادم. تحقّق من حجم الذاكرة المتاحة لخطة الاستضافة الحالية.";
  }
  if (/Got status code|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg) && /browsers install|storage\.googleapis/i.test(msg)) {
    return "تعذّر تنزيل Chrome عند بدء تشغيل الخادم (محاولة التنزيل الذاتي عند التشغيل) بسبب مشكلة شبكة — غالبًا لأن الخادم يمنع الوصول إلى storage.googleapis.com (مصدر تنزيل Chrome الرسمي). تحقّق من أي قيود على الشبكة الصادرة (outbound) في إعدادات الاستضافة، أو أعد المحاولة لاحقًا إن كانت المشكلة مؤقتة من طرف الشبكة.";
  }
  if (/browser folder .* exists but the executable .* is missing/i.test(msg)) {
    return "بقيت نسخة تالفة/غير مكتملة من Chrome من عملية نشر سابقة (المجلد موجود لكن الملف التنفيذي داخله مفقود)، والنسخة الحالية من الكود تحذف هذا المجلد تلقائيًا قبل إعادة التنزيل — إن ظهر هذا الخطأ رغم ذلك، أعد تشغيل الخدمة (Restart) من Render حتى يُعاد تنفيذ منطق التنظيف والتنزيل الذاتي من جديد.";
  }
  return "راجع رسالة الخطأ أعلاه — إن لم تكن واضحة، أرسلها كما هي للمطوّر لتشخيصها.";
}

// Wraps a document's own <body> markup with the RTL shell + embedded font.
// `bodyHtml` should be just the content that would go inside <body> —
// callers don't need to think about the font/charset/direction plumbing.
function wrapHtmlDocument(bodyHtml, { extraCss = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<style>
${fontFaceCss()}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{font-family:"Tajawal","Segoe UI",Tahoma,Arial,sans-serif;direction:rtl;}
${extraCss}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// Renders an HTML string to a PDF buffer. No header/footer template is
// ever passed to Chromium, and displayHeaderFooter stays false — that is
// what actually suppresses Chromium's own default date/URL/page-number
// header and footer at the PDF-generation level (not just visually
// hiding them with CSS, which would leave them in the underlying PDF).
async function renderHtmlToPdf(bodyHtml, {
  extraCss = "",
  format = "A4",
  landscape = false,
  margin = { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
} = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const html = wrapHtmlDocument(bodyHtml, { extraCss });
    await page.setContent(html, { waitUntil: "networkidle0" });
    // Make sure the embedded Arabic font has actually finished loading
    // and is applied before Chromium rasterizes the page to PDF — a race
    // here is exactly the kind of "the font wasn't ready yet" bug that
    // causes silent fallback to a font with no Arabic glyphs.
    await page.evaluateHandle("document.fonts.ready");
    const pdfBuffer = await page.pdf({
      format,
      landscape,
      margin,
      printBackground: true,
      displayHeaderFooter: false, // no date, no URL, no page numbers — see file header note
    });
    return pdfBuffer;
  } catch (e) {
    console.error("✗ فشل توليد PDF أثناء تحويل الصفحة (page.setContent/page.pdf):");
    console.error(e);
    throw e;
  } finally {
    await page.close().catch(() => {}); // page may already be gone if the browser itself crashed above
  }
}

// Lets the server shut the shared browser down cleanly (e.g. on SIGTERM)
// instead of leaving an orphaned Chromium process behind.
async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (e) {
    // already gone / never started — nothing to clean up
  } finally {
    browserPromise = null;
  }
}

module.exports = { renderHtmlToPdf, closeBrowser, checkPdfEngine };
