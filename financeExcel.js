// financeExcel.js — builds the official "تصدير Excel" workbook (section 14).
const ExcelJS = require("exceljs");
const { formatAmount } = require("./financeCore");

async function buildExcelReport({ report, settings, query = {} }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = settings.ligueNameAr;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("التقرير المالي", {
    views: [{ rightToLeft: true }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, paperSize: 9 },
  });

  sheet.mergeCells("A1:H1");
  sheet.getCell("A1").value = settings.ligueNameAr;
  sheet.getCell("A1").font = { size: 16, bold: true, color: { argb: "FF0B6E4F" } };
  sheet.getCell("A1").alignment = { horizontal: "center" };

  sheet.mergeCells("A2:H2");
  sheet.getCell("A2").value = settings.ligueNameFr;
  sheet.getCell("A2").font = { size: 11, italic: true };
  sheet.getCell("A2").alignment = { horizontal: "center" };

  sheet.mergeCells("A3:H3");
  sheet.getCell("A3").value = "التقرير المالي";
  sheet.getCell("A3").font = { size: 13, bold: true };
  sheet.getCell("A3").alignment = { horizontal: "center" };

  const periodText = `الفترة: ${report.range.from || "البداية"} إلى ${report.range.to || "اليوم"}`;
  sheet.mergeCells("A4:H4");
  sheet.getCell("A4").value = report.financialYear ? `السنة المالية: ${report.financialYear.year}  —  ${periodText}` : periodText;
  sheet.getCell("A4").alignment = { horizontal: "center" };

  sheet.mergeCells("A5:H5");
  sheet.getCell("A5").value = `تاريخ إنشاء التقرير: ${new Date().toLocaleString("ar-DZ")}`;
  sheet.getCell("A5").alignment = { horizontal: "center" };
  sheet.getCell("A5").font = { size: 9, color: { argb: "FF666666" } };

  sheet.addRow([]);

  const headerRow = sheet.addRow(["رقم العملية", "التاريخ", "الوقت", "عنوان العملية", "نوع العملية", "جهة الصرف", "المبلغ", "الرصيد بعد العملية"]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B6E4F" } };
    cell.alignment = { horizontal: "center" };
  });

  report.transactions.forEach((t) => {
    const row = sheet.addRow([
      t.transactionNumber,
      t.date,
      t.time || "00:00",
      t.title,
      t.type === "income" ? "دخول" : "خروج",
      t.categoryId ? (t.categoryName || "—") : "—",
      t.amountCents / 100,
      (t.runningBalanceCents ?? 0) / 100,
    ]);
    row.getCell(7).numFmt = "#,##0.00";
    row.getCell(8).numFmt = "#,##0.00";
    if (t.type === "expense") row.getCell(7).font = { color: { argb: "FFC8122E" } };
    else row.getCell(7).font = { color: { argb: "FF0B6E4F" } };
  });

  sheet.addRow([]);
  const totalIncomeRow = sheet.addRow(["", "", "", "", "", "إجمالي المداخيل", report.totalIncomeCents / 100]);
  totalIncomeRow.getCell(7).numFmt = "#,##0.00";
  totalIncomeRow.font = { bold: true };
  const totalExpenseRow = sheet.addRow(["", "", "", "", "", "إجمالي المصاريف", report.totalExpenseCents / 100]);
  totalExpenseRow.getCell(7).numFmt = "#,##0.00";
  totalExpenseRow.font = { bold: true };
  const balanceRow = sheet.addRow(["", "", "", "", "", "الرصيد النهائي", report.balanceCents / 100]);
  balanceRow.getCell(7).numFmt = "#,##0.00";
  balanceRow.font = { bold: true, size: 12 };
  balanceRow.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F2EC" } }; });

  sheet.columns = [
    { width: 14 }, { width: 12 }, { width: 10 }, { width: 26 }, { width: 10 }, { width: 20 }, { width: 16 }, { width: 18 },
  ];

  if (report.byCategory && report.byCategory.length) {
    sheet.addRow([]);
    const catHeader = sheet.addRow(["إجمالي المصاريف حسب جهة الصرف"]);
    catHeader.font = { bold: true };
    const catCols = sheet.addRow(["جهة الصرف", "عدد العمليات", "الإجمالي"]);
    catCols.font = { bold: true };
    report.byCategory.forEach((c) => {
      const row = sheet.addRow([c.categoryName, c.count, c.totalCents / 100]);
      row.getCell(3).numFmt = "#,##0.00";
    });
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildExcelReport };
