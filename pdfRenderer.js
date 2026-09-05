// pdfRenderer.js — shared HTML → PDF engine for the whole platform.
//
// WHY THIS FILE EXISTS (read before touching financePdf.js or any future
// PDF-producing module):
//
// pdfkit (the library financePdf.js used to call directly) has no OpenType
// shaping engine — no HarfBuzz/GSUB, no bidi algorithm. It draws exactly
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
//
// ============================================================================
// HOW CHROMIUM IS OBTAINED (read this before touching getLocalBrowser below)
// ============================================================================
// This went through three approaches on this project's Render Free instance
// before landing here, each confirmed broken for a different reason:
//
//  1. Full "puppeteer" package + its own Chrome download (either at build
//     time via a postinstall script, or lazily at runtime): repeatedly
//     confirmed to silently produce an incomplete/corrupt Chrome binary on
//     Render's Free plan (the download step reported success, no thrown
//     error, but the file at the expected executable path was missing or
//     truncated). Root cause: downloading + unpacking a ~300MB+ Chrome
//     build reliably needs more disk/RAM headroom than Render's Free plan
//     gives a Node web service.
//  2. A remote hosted browser (Browserless.io free tier) via
//     puppeteer.connect(): avoided the download problem, but hit two
//     further issues specific to how these hosted-browser services manage
//     sessions — a cached, reused connection died with "Protocol error:
//     Connection closed" on the second request (fixed by connecting fresh
//     per request), and page.pdf() output was observed corrupted/truncated
//     on at least one run, consistent with the free tier's session/time
//     limits cutting a render short mid-stream.
//  3. (Current) @sparticuz/chromium + "puppeteer-core": a Chromium build
//     purpose-made for exactly this constraint (small/serverless hosts) —
//     shipped brotli-compressed AS PART OF THE NPM PACKAGE ITSELF (~50MB),
//     so `npm install` alone is enough; there is no separate network
//     download step at build or run time to fail. Decompressing it at
//     launch time is a fast local disk operation, not a network transfer,
//     so it doesn't hit the same disk/RAM ceiling that broke approach #1.
//     This is the default now. See getLocalBrowser() below.
//
// An optional PDF_BROWSER_WS_ENDPOINT environment variable is still
// supported as an escape hatch (e.g. to point at Browserless or another
// hosted browser instead) — see connectRemoteBrowser() below — but it is no
// longer the primary path, since approach #3 above resolved the underlying
// problem without needing an external service at all.
// ============================================================================

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

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

// A single local Chromium instance is reused across requests (starting it
// up takes real time, even the fast local decompress-and-launch path below)
// — lazily launched on first use and kept alive for the life of the server
// process.
//
// chromium.executablePath() (from @sparticuz/chromium) does the one-time
// work of decompressing the bundled brotli Chromium archive to a local temp
// path and returns that path — a local disk operation, not a network
// request, so it doesn't depend on any external download succeeding.
// chromium.args carries the sandboxing/stability flags this package
// maintains specifically for constrained container hosts (equivalent in
// purpose to the old hand-written --no-sandbox/--disable-dev-shm-usage
// list, but kept in sync with each Chromium build by the package itself).
let localBrowserPromise = null;
function getLocalBrowser() {
  if (!localBrowserPromise) {
    localBrowserPromise = chromium.executablePath().then((executablePath) => puppeteer.launch({
      executablePath,
      args: chromium.args,
      headless: chromium.headless,
    })).catch((e) => {
      localBrowserPromise = null; // allow retrying on the next call instead of staying broken forever
      // Logged in full here (not just re-thrown) because this is the one
      // place that actually knows this was a *launch* failure specifically
      // — by the time it reaches routes/finance.js's catch block, that
      // context is easy to lose in a generic "تعذر إنشاء ملف PDF" log line.
      console.error("✗ فشل تشغيل Chromium (@sparticuz/chromium) — راجع الرسالة أدناه لمعرفة السبب الدقيق:");
      console.error(e);
      throw e;
    });
  }
  return localBrowserPromise;
}

// Escape hatch, not the default: connect to an already-running Chrome
// hosted elsewhere (e.g. Browserless.io) instead of the local
// @sparticuz/chromium instance above. Only used when PDF_BROWSER_WS_ENDPOINT
// is explicitly set. Opened fresh for every single render and disconnected
// right after — never cached — because hosted-browser services of this kind
// were confirmed (on this project, using Browserless's free tier) to close
// the underlying session after a single use or a short idle window; a
// cached, reused connection reliably failed on the second request with
// "Protocol error: Connection closed".
function connectRemoteBrowser(remoteEndpoint) {
  return puppeteer.connect({ browserWSEndpoint: remoteEndpoint });
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
  const remoteEndpoint = process.env.PDF_BROWSER_WS_ENDPOINT;
  const browser = remoteEndpoint ? await connectRemoteBrowser(remoteEndpoint) : await getLocalBrowser();
  const page = await browser.newPage();
  try {
    const html = wrapHtmlDocument(bodyHtml, { extraCss });
    // Every resource in this document (the Arabic font, all styling) is
    // already embedded as a base64 data URI — there's no real external
    // network activity for "networkidle0" to ever detect, and waiting on it
    // anyway was observed hanging for the full default 30s timeout over a
    // remote CDP connection (a known quirk of navigation-lifecycle tracking
    // on connect()-ed remote sessions). "domcontentloaded" is sufficient
    // (nothing here loads after DOM parse anyway) and immune to that hang.
    // The document.fonts.ready wait right below is what actually guarantees
    // the embedded font is applied before printing, regardless of this
    // setting.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Make sure the embedded Arabic font has actually finished loading
    // and is applied before Chromium rasterizes the page to PDF — a race
    // here is exactly the kind of "the font wasn't ready yet" bug that
    // causes silent fallback to a font with no Arabic glyphs.
    await page.evaluateHandle("document.fonts.ready");
    const pdfBytes = await page.pdf({
      format,
      landscape,
      margin,
      printBackground: true,
      displayHeaderFooter: false, // no date, no URL, no page numbers — see file header note
    });
    // CONFIRMED ROOT CAUSE of "downloads but the PDF file is invalid": recent
    // Puppeteer/puppeteer-core versions return a plain Uint8Array from
    // page.pdf(), not a real Node Buffer. That distinction is invisible
    // almost everywhere — but routes/finance.js hands this straight to
    // Express's res.send(), which only writes raw bytes when
    // Buffer.isBuffer() is true. For a plain Uint8Array (Buffer.isBuffer()
    // is false even though Buffer is technically a Uint8Array subclass —
    // the check is stricter than instanceof), Express silently falls back
    // to res.json() instead, serializing the byte array as a numeric-keyed
    // JSON object — literally {"0":37,"1":80,...} — and the browser
    // downloads THAT as if it were the PDF. That JSON text is exactly what
    // turned up when the "corrupt" .pdf file was opened in a text editor.
    // Buffer.from() forces a genuine Buffer every time, independent of
    // whatever type the installed Puppeteer version happens to return.
    return Buffer.from(pdfBytes);
  } catch (e) {
    console.error("✗ فشل توليد PDF أثناء تحويل الصفحة (page.setContent/page.pdf):");
    console.error(e);
    throw e;
  } finally {
    await page.close().catch(() => {}); // page may already be gone if the browser itself crashed above
    if (remoteEndpoint) {
      browser.disconnect(); // remote session: always drop our connection at the end of this one render — see connectRemoteBrowser() note
    }
  }
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
  if (/error while loading shared libraries|libnss3|libatk|libgbm|libasound/i.test(msg)) {
    return "النظام الأساسي للخادم ينقصه بعض مكتبات النظام التي يحتاجها Chromium (مثل libnss3/libatk/libgbm/libasound). هذه مشكلة شائعة على استضافات تستخدم صورة Linux مصغّرة (Alpine أو صورة Docker خفيفة) — يلزم تثبيت مكتبات Chromium الأساسية على مستوى النظام (على Debian/Ubuntu: `apt-get install -y chromium` أو الحزم المذكورة في رسالة الخطأ)، أو التحويل لصورة Docker تحتويها مسبقًا (مثل صورة Puppeteer الرسمية).";
  }
  if (/Timed out|timeout/i.test(msg)) {
    return "انتهت مهلة تشغيل Chromium أو تحميل الصفحة — غالبًا يعني هذا أن الخادم يعاني من ضغط على الذاكرة/المعالج (شائع على خطط الاستضافة المجانية/الصغيرة). جرّب زيادة موارد الخادم، أو تحقق من عدم وجود عدة عمليات Chromium عالقة من محاولات سابقة.";
  }
  if (/Protocol error|Target closed|Navigation failed|Connection closed/i.test(msg)) {
    return "أُغلقت صفحة Chromium أو انهارت أثناء التوليد — غالبًا بسبب نفاد الذاكرة على الخادم، أو (إن كنت تستخدم PDF_BROWSER_WS_ENDPOINT) انقطاع الاتصال بخدمة Chrome الخارجية. تحقّق من حجم الذاكرة المتاحة لخطة الاستضافة الحالية، ومن حالة الخدمة الخارجية إن كانت مستخدَمة.";
  }
  if (process.env.PDF_BROWSER_WS_ENDPOINT && /connect|websocket|WebSocket|ECONNREFUSED|401|403|unauthorized|invalid token|quota/i.test(msg)) {
    return "فشل الاتصال بخدمة Chrome الخارجية عبر PDF_BROWSER_WS_ENDPOINT. تحقّق من أن رابط الـ WebSocket (وخاصة رمز token الموجود فيه) صحيح ولم تنتهِ صلاحيته، ومن أن الحساب في الخدمة الخارجية لم يتجاوز الحد المجاني الشهري المسموح به.";
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

// Lets the server shut the local persistent browser down cleanly (e.g. on
// SIGTERM) instead of leaving an orphaned Chromium process behind. Only
// relevant to local mode — remote-mode connections are already opened and
// closed per-request inside renderHtmlToPdf(), so there's nothing persistent
// to close here when PDF_BROWSER_WS_ENDPOINT is set.
async function closeBrowser() {
  if (!localBrowserPromise) return;
  try {
    const browser = await localBrowserPromise;
    await browser.close();
  } catch (e) {
    // already gone / never started — nothing to clean up
  } finally {
    localBrowserPromise = null;
  }
}

module.exports = { renderHtmlToPdf, closeBrowser, checkPdfEngine };
