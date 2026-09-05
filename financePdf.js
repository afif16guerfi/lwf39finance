// financePdf.js — builds the official "تصدير PDF" report (section 15).
//
// This module builds a plain HTML document (RTL, real embedded Arabic
// font) and hands it to pdfRenderer.js, which drives headless Chromium to
// print it — the exact same text-layout engine that already renders this
// platform's UI and its browser-print pages correctly. See the top of
// pdfRenderer.js for why this replaced the previous pdfkit + manual
// glyph-shaping approach: pdfkit has no real Arabic shaping/bidi engine,
// so no amount of pre-processing the text in JS ever fully matched what a
// real renderer produces. There is no more Arabic reshaping/reordering
// code involved here — Chromium's own layout does it, the same way it
// does for every other page on the site.
//
// The PDF intentionally contains ONLY the report content below. No date,
// no time, no page numbers, no header/footer are added anywhere — see
// pdfRenderer.js's renderHtmlToPdf(), which always calls Chromium with
// displayHeaderFooter:false so nothing like that is injected into the
// PDF at all, not even something hidden by CSS.
const { formatAmount } = require("./financeCore");
const { renderHtmlToPdf } = require("./pdfRenderer");

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const COLS = [
  { key: "transactionNumber", label: "رقم العملية" },
  { key: "date", label: "التاريخ" },
  { key: "time", label: "الوقت" },
  { key: "title", label: "عنوان العملية" },
  { key: "type", label: "النوع" },
  { key: "category", label: "جهة الصرف" },
  { key: "amount", label: "المبلغ" },
  { key: "balance", label: "الرصيد الحالي" },
];

function buildHtml({ report, settings }) {
  const periodLine = `${report.financialYear ? `السنة المالية: ${esc(report.financialYear.year)}  —  ` : ""}الفترة: ${esc(report.range.from || "البداية")} إلى ${esc(report.range.to || "اليوم")}`;

  const rows = report.transactions.map((t, i) => {
    const cells = {
      transactionNumber: esc(t.transactionNumber),
      date: esc(t.date),
      time: esc(t.time || "00:00"),
      title: esc(t.title),
      type: esc(t.type === "income" ? "دخول" : "خروج"),
      category: esc(t.categoryName || "—"),
      amount: esc(formatAmount(t.amountCents)),
      balance: esc(t.runningBalanceCents != null ? formatAmount(t.runningBalanceCents) : "—"),
    };
    return `<tr class="${i % 2 === 0 ? "alt" : ""} ${t.type === "expense" ? "expense" : ""}">${COLS.map((c) => `<td>${cells[c.key]}</td>`).join("")}</tr>`;
  }).join("\n");

  const openingBalanceHtml = report.financialYear
    ? `<div class="opening-balance">الرصيد الأولي لسنة ${esc(report.financialYear.year)}:  ${esc(formatAmount(report.openingBalanceCents))}</div>`
    : "";

  return `
    <div class="report">
      <div class="head">
        <div class="ligue-ar">${esc(settings.ligueNameAr)}</div>
        <div class="ligue-fr">${esc(settings.ligueNameFr)}</div>
        <div class="report-title">التقرير المالي</div>
        <div class="period">${periodLine}</div>
        ${openingBalanceHtml}
      </div>

      <table class="report-table">
        <thead>
          <tr>${COLS.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <div class="totals">
        <div class="totals-line income">إجمالي المداخيل:  ${esc(formatAmount(report.totalIncomeCents))}</div>
        <div class="totals-line expense">إجمالي المصاريف:  ${esc(formatAmount(report.totalExpenseCents))}</div>
        <div class="totals-line balance">الرصيد النهائي:  ${esc(formatAmount(report.balanceCents))}</div>
      </div>
    </div>
  `;
}

const CSS = `
  .report{ font-size:10.5pt; color:#111; }
  .head{ text-align:center; margin-bottom:14px; }
  .ligue-ar{ font-weight:700; font-size:16pt; color:#0b6e4f; }
  .ligue-fr{ font-size:10pt; color:#333; direction:ltr; font-family:Tahoma,Arial,sans-serif; }
  .report-title{ font-weight:700; font-size:13pt; color:#111; margin-top:6px; }
  .period{ font-size:10pt; color:#444; margin-top:4px; }
  .opening-balance{ font-weight:700; font-size:10pt; color:#0b6e4f; margin-top:4px; }

  .report-table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .report-table th{ background:#0b6e4f; color:#fff; font-weight:700; font-size:9pt; padding:6px 4px; text-align:center; }
  .report-table td{ font-size:8.5pt; padding:5px 4px; text-align:center; border-bottom:1px solid #eee; word-break:break-word; }
  .report-table tr.alt td{ background:#f7f4ea; }
  .report-table tr.expense td{ color:#c8122e; }
  .report-table tr.expense td:first-child{ color:inherit; }
  .report-table thead{ display:table-header-group; } /* repeats the header row on every printed page */
  .report-table tr{ page-break-inside:avoid; }

  .totals{ margin-top:14px; text-align:center; }
  .totals-line{ font-weight:700; font-size:10pt; margin:4px 0; }
  .totals-line.income{ color:#0b6e4f; }
  .totals-line.expense{ color:#c8122e; }
  .totals-line.balance{ color:#0b6e4f; }
`;

async function buildPdfReport({ report, settings }) {
  const bodyHtml = buildHtml({ report, settings });
  return renderHtmlToPdf(bodyHtml, { extraCss: CSS, format: "A4", landscape: false });
}

module.exports = { buildPdfReport };
