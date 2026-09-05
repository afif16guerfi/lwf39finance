// finance.js — the "المالية" mini-SPA. Vanilla JS, no build step, same
// pattern as the referee-platform's own public/app.js. Reuses the SAME
// localStorage session key ("lwf_session") as the main app, so anyone
// already logged in as admin there is automatically logged in here too.
(function () {
  "use strict";

  const SESSION_KEY = "lwf_session";
  const root = document.getElementById("fin-app");

  // ============================================================
  // Session + API helpers
  // ============================================================
  function getSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
  function setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }

  async function api(path, { method = "GET", body, isForm = false } = {}) {
    const session = getSession();
    const headers = {};
    if (session && session.token) headers["Authorization"] = "Bearer " + session.token;
    let payload = body;
    if (body && !isForm) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch("/api" + path, { method, headers, body: payload });
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401) { clearSession(); render(); throw new Error(data.error || "الجلسة منتهية."); }
    if (!res.ok) throw new Error(data.error || "حدث خطأ غير متوقع.");
    return data;
  }

  function qs(obj) {
    const parts = [];
    Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`); });
    return parts.length ? "?" + parts.join("&") : "";
  }

  // Excel/PDF export must carry the same "Authorization: Bearer <token>"
  // every other API call uses — a plain <a href="..."> / window.open(url)
  // never sends that header, so the export endpoint (protected by
  // middleware/auth.js requireAuth, same as everything else) always
  // rejected it with "يلزم تسجيل الدخول", even for an already-logged-in
  // user. Fetch it ourselves with the header, read the file back as a
  // Blob, then trigger the download from a temporary object URL.
  async function downloadExport(kind, params) {
    const session = getSession();
    const headers = {};
    if (session && session.token) headers["Authorization"] = "Bearer " + session.token;
    let res;
    try {
      res = await fetch("/api/finance/export/" + kind + qs(params), { headers });
    } catch (e) {
      toast("تعذّر الاتصال بالخادم لتصدير الملف ✕", "error");
      return;
    }
    if (res.status === 401) {
      clearSession();
      render();
      toast("الجلسة منتهية، يرجى تسجيل الدخول من جديد.", "error");
      return;
    }
    if (!res.ok) {
      let message = "تعذّر تصدير الملف.";
      try { const errBody = await res.json(); if (errBody && errBody.error) message = errBody.error; } catch (e) { /* no JSON body */ }
      toast(message, "error");
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/i);
    const filename = match ? match[1] : `finance-report.${kind === "excel" ? "xlsx" : "pdf"}`;
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  }

  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ============================================================
  // Toasts
  // ============================================================
  let toastWrap = null;
  function toast(message, type = "success") {
    if (!toastWrap) {
      toastWrap = document.createElement("div");
      toastWrap.className = "fin-toast-wrap";
      document.body.appendChild(toastWrap);
    }
    const el = document.createElement("div");
    el.className = "fin-toast " + type;
    el.textContent = message;
    toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ============================================================
  // Router
  // ============================================================
  const NAV_ITEMS = [
    { hash: "#/dashboard", label: "لوحة التحكم", emoji: "🏠", roles: ["admin", "finance_admin", "finance_viewer"] },
    { hash: "#/transactions/manage", label: "العمليات المالية", emoji: "💳", roles: ["admin", "finance_admin"] },
    { hash: "#/transactions", label: "جميع العمليات", emoji: "📋", roles: ["admin", "finance_admin", "finance_viewer"] },
    { hash: "#/reports", label: "التقارير المالية", emoji: "📊", roles: ["admin", "finance_admin", "finance_viewer"] },
    { hash: "#/categories", label: "جهات الصرف", emoji: "🏢", roles: ["admin"] },
    { hash: "#/years", label: "السنوات المالية", emoji: "🗓️", roles: ["admin", "finance_admin", "finance_viewer"] },
    { hash: "#/users", label: "المستخدمون", emoji: "👥", roles: ["admin"] },
    { hash: "#/audit", label: "سجل التدقيق", emoji: "🔐", roles: ["admin", "finance_admin"] },
    { hash: "#/settings", label: "الإعدادات", emoji: "⚙️", roles: ["admin"] },
  ];

  function currentRoute() { return location.hash || "#/dashboard"; }

  window.addEventListener("hashchange", render);

  // ============================================================
  // Shell
  // ============================================================
  function shellHtml(user, activeHash, years, activeFinancialYearId) {
    const navHtml = NAV_ITEMS.filter((n) => n.roles.includes(user.role)).map((n) => `
      <a href="${n.hash}" class="fin-nav-item ${n.hash === activeHash ? "active" : ""}" data-nav>
        <span class="fin-nav-emoji">${n.emoji}</span> ${n.label}
      </a>`).join("");

    const roleLabel = { admin: "مدير النظام", finance_admin: "المسؤول المالي", finance_viewer: "مستخدم للعرض" }[user.role] || user.role;

    const yearSwitcherHtml = (years && years.length)
      ? `<select id="fin-year-switcher" class="fin-year-switcher" title="السنة المالية النشطة">
          ${years.map((y) => `<option value="${y.id}" ${y.id === activeFinancialYearId ? "selected" : ""}>${y.status !== "active" ? "🚫 " : "🗓️ "}${esc(String(y.year))}</option>`).join("")}
        </select>`
      : `<a href="#/years" class="fin-btn fin-btn-primary fin-btn-sm">+ إنشاء سنة مالية</a>`;

    return `
    <div class="fin-shell">
      <aside class="fin-sidebar" id="fin-sidebar">
        <div class="fin-brand">
          <img src="/assets/logo.png" alt="شعار" onerror="this.style.display='none'">
          <div class="fin-brand-text">النظام المالي<br><span class="fin-muted" style="font-weight:400;font-size:11px;">الرابطة الولائية لكرة القدم الوادي</span></div>
        </div>
        <nav class="fin-nav">${navHtml}
          <a href="/" class="fin-nav-item"><span class="fin-nav-emoji">↩️</span> العودة للمنصة الرئيسية</a>
        </nav>
        <div class="fin-sidebar-foot">
          <button class="fin-btn fin-btn-ghost fin-btn-sm" style="width:100%" id="fin-logout">🚪 تسجيل الخروج</button>
        </div>
      </aside>
      <div class="fin-sidebar-backdrop" id="fin-sidebar-backdrop"></div>
      <div class="fin-main">
        <header class="fin-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <button class="fin-menu-toggle" id="fin-menu-toggle">☰</button>
            <div class="fin-header-title" id="fin-header-title">النظام المالي</div>
          </div>
          <div class="fin-header-user" style="gap:14px;">
            ${yearSwitcherHtml}
            <span>${esc(user.fullNameAr || user.username)}</span>
            <span class="fin-role-badge">${roleLabel}</span>
          </div>
        </header>
        <main class="fin-content" id="fin-content"></main>
      </div>
    </div>`;
  }

  function mountShell(user, years, activeFinancialYearId) {
    root.innerHTML = shellHtml(user, currentRoute(), years, activeFinancialYearId);
    document.getElementById("fin-logout").addEventListener("click", () => { clearSession(); render(); });
    document.getElementById("fin-menu-toggle").addEventListener("click", () => {
      document.getElementById("fin-sidebar").classList.toggle("open");
      document.getElementById("fin-sidebar-backdrop").classList.toggle("show");
    });
    document.getElementById("fin-sidebar-backdrop").addEventListener("click", () => {
      document.getElementById("fin-sidebar").classList.remove("open");
      document.getElementById("fin-sidebar-backdrop").classList.remove("show");
    });
    root.querySelectorAll("[data-nav]").forEach((a) => a.addEventListener("click", () => {
      document.getElementById("fin-sidebar").classList.remove("open");
      document.getElementById("fin-sidebar-backdrop").classList.remove("show");
    }));
    const switcher = document.getElementById("fin-year-switcher");
    if (switcher) {
      switcher.addEventListener("change", async () => {
        try {
          await api(`/finance/years/${switcher.value}/activate`, { method: "POST" });
          toast("تم التبديل إلى السنة المالية المختارة ✓");
          render();
        } catch (err) {
          toast(err.message || "تعذّر التبديل بين السنوات المالية ✕", "error");
        }
      });
    }
  }

  // ============================================================
  // Login screen
  // ============================================================
  function renderLogin(errorMsg) {
    root.innerHTML = `
    <div class="fin-login-wrap">
      <div class="fin-login-card">
        <img class="fin-login-logo" src="/assets/logo.png" alt="شعار" onerror="this.style.display='none'">
        <h1 class="fin-login-title">النظام المالي</h1>
        <p class="fin-login-sub">الرابطة الولائية لكرة القدم الوادي — LIGUE WILAYA DE FOOTBALL ELOUED</p>
        <form id="fin-login-form">
          <div class="fin-field"><label>اسم المستخدم</label><input name="username" required autofocus></div>
          <div class="fin-field"><label>كلمة المرور</label><input name="password" type="password" required></div>
          <div class="fin-error">${esc(errorMsg || "")}</div>
          <button class="fin-btn fin-btn-primary" style="width:100%" type="submit">تسجيل الدخول</button>
        </form>
      </div>
    </div>`;
    document.getElementById("fin-login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector("button");
      btn.disabled = true;
      try {
        const { token, user } = await api("/auth/login", { method: "POST", body: { username: fd.get("username").trim(), password: fd.get("password") } });
        if (!["admin", "finance_admin", "finance_viewer"].includes(user.role)) {
          throw new Error("هذا الحساب لا يملك صلاحية الوصول إلى النظام المالي.");
        }
        setSession({ token, user });
        render();
      } catch (err) {
        renderLogin(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // Money helpers (display only — the server is the source of truth)
  // ============================================================
  function fmtMoney(v) {
    const n = Number(v) || 0;
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " دج";
  }

  // ============================================================
  // Simple dependency-free SVG bar+line chart (income / expense / balance)
  // ============================================================
  function renderChart(monthly) {
    if (!monthly || !monthly.length) return `<p class="fin-muted">لا توجد بيانات كافية لعرض الرسم البياني بعد.</p>`;
    const W = 760, H = 260, padL = 50, padB = 30, padT = 10, padR = 10;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = Math.max(1, ...monthly.map((m) => Math.max(m.income, m.expense)));
    const barGroupW = innerW / monthly.length;
    const barW = Math.min(22, barGroupW / 3);

    const bars = monthly.map((m, i) => {
      const gx = padL + i * barGroupW + barGroupW / 2;
      const incH = (m.income / maxVal) * innerH;
      const expH = (m.expense / maxVal) * innerH;
      return `
        <rect x="${gx - barW - 2}" y="${padT + innerH - incH}" width="${barW}" height="${incH}" fill="var(--green-deep,#0b6e4f)" rx="2"></rect>
        <rect x="${gx + 2}" y="${padT + innerH - expH}" width="${barW}" height="${expH}" fill="var(--red-accent,#c8122e)" rx="2"></rect>
        <text x="${gx}" y="${H - 8}" font-size="9" text-anchor="middle" fill="var(--ink-soft,#666)">${esc(m.month.slice(2))}</text>
      `;
    }).join("");

    const maxBal = Math.max(1, ...monthly.map((m) => Math.abs(m.balance)));
    const linePoints = monthly.map((m, i) => {
      const gx = padL + i * barGroupW + barGroupW / 2;
      const gy = padT + innerH - ((m.balance / (maxBal * 1.1)) * innerH / 2 + innerH / 2);
      return `${gx},${Math.max(padT, Math.min(padT + innerH, gy))}`;
    }).join(" ");

    return `
    <div class="fin-chart-legend">
      <span><i class="fin-dot" style="background:var(--green-deep,#0b6e4f)"></i> المداخيل</span>
      <span><i class="fin-dot" style="background:var(--red-accent,#c8122e)"></i> المصاريف</span>
      <span><i class="fin-dot" style="background:var(--ink,#1c2620)"></i> تطور الرصيد</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:280px;">
      ${bars}
      <polyline points="${linePoints}" fill="none" stroke="var(--ink,#1c2620)" stroke-width="2"></polyline>
    </svg>`;
  }

  // ============================================================
  // Reusable: category <select> options
  // ============================================================
  async function loadCategories() { return (await api("/finance/categories")).categories; }

  // ============================================================
  // Transaction form (used by the unified #/transactions/manage tabs, and
  // the edit modal)
  // ============================================================
  function transactionFormHtml(type, categories, existing) {
    const isExpense = type === "expense";
    const catOptions = categories.filter((c) => c.status === "active" || c.id === (existing && existing.categoryId))
      .map((c) => `<option value="${c.id}" ${existing && existing.categoryId === c.id ? "selected" : ""}>${esc(c.name)}${c.status !== "active" ? " (معطّلة)" : ""}</option>`).join("");

    return `
    <form id="fin-txn-form" enctype="multipart/form-data">
      <input type="hidden" name="type" value="${type}">
      <div class="fin-grid-2">
        <div class="fin-field"><label>عنوان العملية *</label><input name="title" required value="${esc(existing && existing.title || "")}" placeholder="${isExpense ? "مثال: شراء تجهيزات" : "مثال: إعانة مالية"}"></div>
        <div class="fin-field"><label>المبلغ (دج) *</label><input name="amount" required type="number" step="0.01" min="0.01" value="${existing ? existing.amount : ""}" placeholder="0.00"></div>
      </div>
      <div class="fin-grid-2">
        <div class="fin-field"><label>التاريخ *</label><input name="date" required type="date" value="${existing ? existing.date : new Date().toISOString().slice(0, 10)}"></div>
        <div class="fin-field"><label>الوقت *</label><input name="time" required type="time" value="${existing ? existing.time || "00:00" : new Date().toTimeString().slice(0, 5)}"></div>
      </div>
      ${isExpense ? `
      <div class="fin-field"><label>جهة الصرف *</label><select name="categoryId" required><option value="">اختر جهة الصرف</option>${catOptions}</select></div>
      <div class="fin-field"><label>تفاصيل الصرف</label><textarea name="details" placeholder="مثال: شراء 10 كرات تدريب + 5 أطقم رياضية">${esc(existing && existing.details || "")}</textarea></div>
      ` : ""}
      <div class="fin-field"><label>ملاحظات</label><textarea name="notes">${esc(existing && existing.notes || "")}</textarea></div>
      <div class="fin-field">
        <label>إرفاق الفاتورة / الوثيقة (PDF / JPG / PNG)</label>
        ${existing && existing.attachment ? `<div class="fin-attachment-box"><span>📎 ${esc(existing.attachment.originalName)}</span>
          <a href="${existing.attachment.url}" target="_blank" class="fin-btn fin-btn-ghost fin-btn-sm">عرض</a></div>
          <label style="font-size:12px;margin-top:6px;display:block;"><input type="checkbox" name="removeAttachment" value="true"> إزالة الملف الحالي</label>` : ""}
        <input name="attachment" type="file" accept=".pdf,.jpg,.jpeg,.png" style="margin-top:8px;">
      </div>
      <div class="fin-error" id="fin-txn-error"></div>
      <div class="fin-form-actions">
        <button class="fin-btn fin-btn-primary" type="submit">${existing ? "حفظ التعديلات" : "حفظ العملية"} ✓</button>
      </div>
    </form>`;
  }

  function wireTransactionForm(formEl, { type, existingId, onSaved }) {
    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = formEl.querySelector("button[type=submit]");
      const errBox = formEl.querySelector("#fin-txn-error");
      errBox.textContent = "";
      btn.disabled = true;
      btn.textContent = "جارٍ الحفظ...";
      try {
        const fd = new FormData(formEl);
        if (fd.get("removeAttachment") !== "true") fd.delete("removeAttachment");
        const path = existingId ? `/finance/transactions/${existingId}` : "/finance/transactions";
        await api(path, { method: existingId ? "PUT" : "POST", body: fd, isForm: true });
        toast(existingId ? "تم تعديل العملية بنجاح ✓" : "تمت إضافة العملية بنجاح ✓", "success");
        if (onSaved) onSaved();
      } catch (err) {
        errBox.textContent = err.message || "تعذّر حفظ العملية ✕";
        toast("تعذّر حفظ العملية ✕", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = existingId ? "حفظ التعديلات ✓" : "حفظ العملية ✓";
      }
    });
  }

  // ============================================================
  // Pages
  // ============================================================
  const Pages = {};

  Pages["#/dashboard"] = async function (user) {
    const content = document.getElementById("fin-content");
    content.innerHTML = `<div class="fin-loading">جارٍ التحميل...</div>`;
    const summary = await api("/finance/summary");
    content.innerHTML = `
      <p class="fin-section-title">مرحبًا بك في النظام المالي</p>
      <p class="fin-section-sub">${new Date().toLocaleDateString("ar-DZ", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
      <div class="fin-cards">
        <div class="fin-card balance"><div class="fin-card-label">🔵 الرصيد الحالي</div><div class="fin-card-value">${esc(summary.balanceFormatted)}</div></div>
        <div class="fin-card income"><div class="fin-card-label">🟢 إجمالي المداخيل</div><div class="fin-card-value">${esc(summary.totalIncomeFormatted)}</div></div>
        <div class="fin-card expense"><div class="fin-card-label">🔴 إجمالي المصاريف</div><div class="fin-card-value">${esc(summary.totalExpenseFormatted)}</div></div>
        <div class="fin-card"><div class="fin-card-label">عدد العمليات</div><div class="fin-card-value">${summary.transactionCount} عملية</div></div>
      </div>
      <div class="fin-panel">
        <div class="fin-panel-title">تطور المداخيل والمصاريف (آخر 12 شهرًا)</div>
        ${renderChart(summary.monthly)}
      </div>
      <div class="fin-panel">
        <div class="fin-panel-title">آخر العمليات</div>
        ${renderTxnTable(summary.recentTransactions, { compact: true })}
      </div>`;
    wireTableRowClicks(content, user);
  };

  function txnRow(t) {
    return `<tr data-id="${t.id}">
      <td>${esc(t.transactionNumber)}</td>
      <td>${esc(t.date)} - ${esc(t.time || "00:00")}</td>
      <td style="text-align:right">${esc(t.title)}</td>
      <td><span class="fin-badge ${t.type}">${t.type === "income" ? "دخول" : "خروج"}</span></td>
      <td>${esc(t.categoryName || "—")}</td>
      <td class="${t.type === "income" ? "fin-amount-income" : "fin-amount-expense"}">${t.type === "income" ? "+" : "-"}${esc(t.amountFormatted)}</td>
      <td>${t.runningBalanceFormatted ? esc(t.runningBalanceFormatted) : "—"}</td>
    </tr>`;
  }

  function renderTxnTable(items, { compact = false } = {}) {
    if (!items.length) return `<div class="fin-empty">لا توجد عمليات مالية حاليًا</div>`;
    return `<div class="fin-table-wrap"><table class="fin-table">
      <thead><tr><th>رقم العملية</th><th>التاريخ والوقت</th><th>عنوان العملية</th><th>نوع العملية</th><th>جهة الصرف</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
      <tbody>${items.map(txnRow).join("")}</tbody>
    </table></div>`;
  }

  function wireTableRowClicks(container, user) {
    container.querySelectorAll("tbody tr[data-id]").forEach((tr) => {
      tr.addEventListener("click", () => openTransactionDetail(tr.getAttribute("data-id"), user));
    });
  }

  // ---- Unified financial-operations page: عمليات الدخول / عمليات الخروج
  // in one page, switched via tabs instead of two separate pages the user
  // had to navigate between (replaces the old separate #/income and
  // #/expense pages) — each tab keeps 100% of what those pages had: the
  // add form, edit, delete, search, filters, pagination, and attachment
  // viewing.
  const manageState = {
    activeTab: "income",
    income: { page: 1, pageSize: 20, order: "newest" },
    expense: { page: 1, pageSize: 20, order: "newest" },
  };

  function manageFilterBarHtml(type, categories) {
    const catOptions = categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    return `
      <div class="fin-filters">
        <div class="fin-field"><label>بحث</label><input id="m-${type}-q" placeholder="رقم العملية / العنوان / التفاصيل"></div>
        ${type === "expense" ? `<div class="fin-field"><label>جهة الصرف</label><select id="m-${type}-cat"><option value="">الكل</option>${catOptions}</select></div>` : ""}
        <div class="fin-field"><label>من تاريخ</label><input id="m-${type}-from" type="date"></div>
        <div class="fin-field"><label>إلى تاريخ</label><input id="m-${type}-to" type="date"></div>
        <div class="fin-field"><label>الترتيب</label><select id="m-${type}-order"><option value="newest">الأحدث أولًا</option><option value="oldest">الأقدم أولًا</option></select></div>
        <div class="fin-field"><label>عدد الصفوف</label><select id="m-${type}-size"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></div>
      </div>
      <div class="fin-form-actions"><button class="fin-btn fin-btn-primary fin-btn-sm" id="m-${type}-apply">🔍 تطبيق البحث</button></div>`;
  }

  async function refreshManageList(type, user) {
    const state = manageState[type];
    const list = await api("/finance/transactions" + qs({ ...state, type }));
    const wrap = document.getElementById(`m-${type}-results`);
    wrap.innerHTML = `
      <div class="fin-panel-title">
        <span>${list.total} عملية — الإجمالي ${esc(type === "income" ? list.totalIncomeFormatted : list.totalExpenseFormatted)}</span>
      </div>
      ${renderTxnTable(list.items)}
      <div class="fin-pagination">
        <span>صفحة ${list.page} من ${list.totalPages}</span>
        <div style="display:flex;gap:6px;">
          <button class="fin-btn fin-btn-ghost fin-btn-sm" ${list.page <= 1 ? "disabled" : ""} data-page="${list.page - 1}">السابق</button>
          <button class="fin-btn fin-btn-ghost fin-btn-sm" ${list.page >= list.totalPages ? "disabled" : ""} data-page="${list.page + 1}">التالي</button>
        </div>
      </div>`;
    wrap.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
      state.page = parseInt(b.getAttribute("data-page"), 10);
      refreshManageList(type, user);
    }));
    wireTableRowClicks(wrap, user);
  }

  function manageTabPaneHtml(type, categories) {
    return `
      <div class="fin-panel">${transactionFormHtml(type, categories)}</div>
      <div class="fin-panel">
        <div class="fin-panel-title">${type === "income" ? "عمليات الدخول" : "عمليات الخروج"} — البحث والفلاتر</div>
        ${manageFilterBarHtml(type, categories)}
      </div>
      <div class="fin-panel" id="m-${type}-results"></div>`;
  }

  function wireManageTabPane(type, user) {
    wireTransactionForm(document.getElementById("fin-txn-form"), { type, onSaved: () => renderManagePage(user) });
    document.getElementById(`m-${type}-apply`).addEventListener("click", () => {
      manageState[type] = {
        page: 1,
        pageSize: document.getElementById(`m-${type}-size`).value,
        order: document.getElementById(`m-${type}-order`).value,
        q: document.getElementById(`m-${type}-q`).value,
        categoryId: type === "expense" ? document.getElementById(`m-${type}-cat`).value : undefined,
        dateFrom: document.getElementById(`m-${type}-from`).value,
        dateTo: document.getElementById(`m-${type}-to`).value,
      };
      refreshManageList(type, user);
    });
    refreshManageList(type, user);
  }

  async function renderManagePage(user) {
    const content = document.getElementById("fin-content");
    content.innerHTML = `<div class="fin-loading">جارٍ التحميل...</div>`;
    const categories = await loadCategories();
    content.innerHTML = `
      <p class="fin-section-title">العمليات المالية</p>
      <p class="fin-section-sub">تسجيل وإدارة عمليات الدخول والخروج في مكان واحد.</p>
      <div class="fin-tabs" role="tablist">
        <button type="button" class="fin-tab ${manageState.activeTab === "income" ? "active" : ""}" data-tab="income" role="tab">💰 عمليات الدخول</button>
        <button type="button" class="fin-tab ${manageState.activeTab === "expense" ? "active" : ""}" data-tab="expense" role="tab">💸 عمليات الخروج</button>
      </div>
      <div id="fin-tab-pane"></div>`;

    function showTab(type) {
      manageState.activeTab = type;
      content.querySelectorAll(".fin-tab").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === type));
      document.getElementById("fin-tab-pane").innerHTML = manageTabPaneHtml(type, categories);
      wireManageTabPane(type, user);
    }
    content.querySelectorAll(".fin-tab").forEach((b) => b.addEventListener("click", () => showTab(b.getAttribute("data-tab"))));
    showTab(manageState.activeTab);
  }
  Pages["#/transactions/manage"] = renderManagePage;

  // ---- All transactions (with full filters, both types combined) ----
  let txnFilterState = { page: 1, pageSize: 20, order: "newest" };
  Pages["#/transactions"] = async function (user) {
    const content = document.getElementById("fin-content");
    content.innerHTML = `<div class="fin-loading">جارٍ التحميل...</div>`;
    const categories = await loadCategories();
    const canManage = ["admin", "finance_admin"].includes(user.role);

    async function refresh() {
      const list = await api("/finance/transactions" + qs(txnFilterState));
      document.getElementById("fin-txn-results").innerHTML = `
        <div class="fin-panel-title">
          <span>${list.total} عملية — مداخيل ${esc(list.totalIncomeFormatted)} · مصاريف ${esc(list.totalExpenseFormatted)} · الصافي ${esc(list.netFormatted)}</span>
          <div style="display:flex;gap:8px;">
            <button class="fin-btn fin-btn-ghost fin-btn-sm" id="fin-export-excel">⬇️ Excel</button>
            <button class="fin-btn fin-btn-ghost fin-btn-sm" id="fin-export-pdf">⬇️ PDF</button>
            <button class="fin-btn fin-btn-ghost fin-btn-sm" id="fin-print-btn">🖨️ طباعة</button>
          </div>
        </div>
        ${renderTxnTable(list.items)}
        <div class="fin-pagination">
          <span>صفحة ${list.page} من ${list.totalPages}</span>
          <div style="display:flex;gap:6px;">
            <button class="fin-btn fin-btn-ghost fin-btn-sm" ${list.page <= 1 ? "disabled" : ""} data-page="${list.page - 1}">السابق</button>
            <button class="fin-btn fin-btn-ghost fin-btn-sm" ${list.page >= list.totalPages ? "disabled" : ""} data-page="${list.page + 1}">التالي</button>
          </div>
        </div>`;
      document.getElementById("fin-export-excel").addEventListener("click", () => downloadExport("excel", txnFilterState));
      document.getElementById("fin-export-pdf").addEventListener("click", () => downloadExport("pdf", txnFilterState));
      document.getElementById("fin-print-btn").addEventListener("click", () => window.print());
      document.getElementById("fin-txn-results").querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
        txnFilterState.page = parseInt(b.getAttribute("data-page"), 10);
        refresh();
      }));
      wireTableRowClicks(document.getElementById("fin-txn-results"), user);
    }

    const catOptions = categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");

    content.innerHTML = `
      <p class="fin-section-title">الحسابات المالية — جميع العمليات</p>
      <div class="fin-panel">
        <div class="fin-filters">
          <div class="fin-field"><label>بحث</label><input id="f-q" placeholder="رقم العملية / العنوان / التفاصيل"></div>
          <div class="fin-field"><label>النوع</label><select id="f-type"><option value="">الكل</option><option value="income">دخول</option><option value="expense">خروج</option></select></div>
          <div class="fin-field"><label>جهة الصرف</label><select id="f-cat"><option value="">الكل</option>${catOptions}</select></div>
          <div class="fin-field"><label>من تاريخ</label><input id="f-from" type="date"></div>
          <div class="fin-field"><label>إلى تاريخ</label><input id="f-to" type="date"></div>
          <div class="fin-field"><label>الترتيب</label><select id="f-order"><option value="newest">الأحدث أولًا</option><option value="oldest">الأقدم أولًا</option></select></div>
          <div class="fin-field"><label>عدد الصفوف</label><select id="f-size"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></div>
        </div>
        <div class="fin-form-actions"><button class="fin-btn fin-btn-primary fin-btn-sm" id="fin-apply-filters">🔍 تطبيق البحث</button></div>
      </div>
      <div class="fin-panel" id="fin-txn-results"></div>`;

    document.getElementById("fin-apply-filters").addEventListener("click", () => {
      txnFilterState = {
        page: 1,
        pageSize: document.getElementById("f-size").value,
        order: document.getElementById("f-order").value,
        q: document.getElementById("f-q").value,
        type: document.getElementById("f-type").value,
        categoryId: document.getElementById("f-cat").value,
        dateFrom: document.getElementById("f-from").value,
        dateTo: document.getElementById("f-to").value,
      };
      refresh();
    });
    refresh();
  };

  // ---- Transaction detail modal ----
  async function openTransactionDetail(id, user) {
    const { transaction: t } = await api("/finance/transactions/" + id);
    const canManage = ["admin", "finance_admin"].includes(user.role);
    const canDelete = user.role === "admin";
    const overlay = document.createElement("div");
    overlay.className = "fin-modal-overlay";
    overlay.innerHTML = `
      <div class="fin-modal">
        <div class="fin-modal-head"><h3>تفاصيل العملية ${esc(t.transactionNumber)}</h3><button class="fin-modal-close">&times;</button></div>
        <p><b>النوع:</b> <span class="fin-badge ${t.type}">${t.type === "income" ? "دخول" : "خروج"}</span></p>
        <p><b>العنوان:</b> ${esc(t.title)}</p>
        <p><b>المبلغ:</b> <span class="${t.type === "income" ? "fin-amount-income" : "fin-amount-expense"}">${esc(t.amountFormatted)}</span></p>
        <p><b>التاريخ والوقت:</b> ${esc(t.date)} - ${esc(t.time || "00:00")}</p>
        ${t.categoryName ? `<p><b>جهة الصرف:</b> ${esc(t.categoryName)}</p>` : ""}
        ${t.details ? `<p><b>تفاصيل الصرف:</b> ${esc(t.details)}</p>` : ""}
        ${t.notes ? `<p><b>ملاحظات:</b> ${esc(t.notes)}</p>` : ""}
        <p><b>الرصيد بعد هذه العملية:</b> ${esc(t.runningBalanceFormatted || "—")}</p>
        <p><b>أنشأها:</b> ${esc(t.createdByName)} — ${new Date(t.createdAt).toLocaleString("ar-DZ")}</p>
        ${t.updatedByName ? `<p><b>آخر تعديل:</b> ${esc(t.updatedByName)} — ${new Date(t.updatedAt).toLocaleString("ar-DZ")}</p>` : ""}
        ${t.attachment ? `<div class="fin-attachment-box"><span>📎 ${esc(t.attachment.originalName)}</span><a href="${t.attachment.url}" target="_blank" class="fin-btn fin-btn-ghost fin-btn-sm">عرض / تحميل</a></div>` : `<p class="fin-muted">لا توجد فاتورة مرفقة.</p>`}
        <div class="fin-panel-title" style="margin-top:14px;font-size:14px;">سجل التعديلات</div>
        <div class="fin-timeline">${(t.history || []).map((h) => `<div class="fin-timeline-item"><b>${esc(h.event)}</b><br><span class="fin-muted">${esc(h.byName || "")} — ${new Date(h.at).toLocaleString("ar-DZ")}</span></div>`).join("")}</div>
        <div class="fin-form-actions">
          ${canManage ? `<button class="fin-btn fin-btn-ghost fin-btn-sm" id="fin-edit-txn">✏️ تعديل</button>` : ""}
          ${canDelete ? `<button class="fin-btn fin-btn-danger fin-btn-sm" id="fin-delete-txn">🗑️ حذف</button>` : ""}
        </div>
        <div id="fin-edit-area"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector(".fin-modal-close").addEventListener("click", () => overlay.remove());

    if (canManage) {
      overlay.querySelector("#fin-edit-txn").addEventListener("click", async () => {
        const categories = await loadCategories();
        document.getElementById("fin-edit-area").innerHTML = transactionFormHtml(t.type, categories, t);
        wireTransactionForm(document.getElementById("fin-txn-form"), {
          type: t.type, existingId: t.id,
          onSaved: () => { overlay.remove(); Pages[currentRoute()](user); },
        });
      });
    }
    if (canDelete) {
      overlay.querySelector("#fin-delete-txn").addEventListener("click", async () => {
        if (!confirm(`هل أنت متأكد من حذف العملية رقم ${t.transactionNumber}؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
        try {
          await api("/finance/transactions/" + t.id, { method: "DELETE" });
          toast("تم حذف العملية بنجاح ✓", "success");
          overlay.remove();
          Pages[currentRoute()](user);
        } catch (err) { toast(err.message || "تعذّر حذف العملية ✕", "error"); }
      });
    }
  }

  // ---- Reports ----
  // ---- Financial reports + professional print (section 13) ----
  // Auto-generates the report title from whatever scope the user picked —
  // matching the brief's exact examples ("عمليات السنة المالية 2025",
  // "عمليات شهر جوان للسنة المالية 2025", "عمليات الفترة من .. إلى .. للسنة
  // المالية 2025") — and prints ONLY that title + period line + the plain
  // transactions table, via a dedicated #fin-print-area kept out of the
  // normal page flow (see finance.css) so no dashboard chrome ever leaks
  // into the printed page, with an explicit portrait/landscape choice
  // applied to the actual @page CSS before printing.
  const AR_MONTHS = ["جانفي","فيفري","مارس","أفريل","ماي","جوان","جويلية","أوت","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  function buildReportTitle(scope, financialYearLabel) {
    if (scope.mode === "year") return `عمليات السنة المالية ${esc(financialYearLabel)}`;
    if (scope.mode === "month") {
      const [y, m] = scope.month.split("-");
      return `عمليات شهر ${AR_MONTHS[parseInt(m, 10) - 1]} للسنة المالية ${esc(financialYearLabel)}`;
    }
    return `عمليات الفترة من ${scope.from} إلى ${scope.to} للسنة المالية ${esc(financialYearLabel)}`;
  }
  function printFinancialReport(report, title, subtitle) {
    let area = document.getElementById("fin-print-area");
    if (!area) { area = document.createElement("div"); area.id = "fin-print-area"; document.body.appendChild(area); }
    const rows = report.transactions.map((t) => `<tr>
        <td>${esc(t.transactionNumber)}</td>
        <td>${esc(t.date)} - ${esc(t.time || "00:00")}</td>
        <td class="fin-title-cell">${esc(t.title)}</td>
        <td>${t.type === "income" ? "دخول" : "خروج"}</td>
        <td>${esc(t.categoryName || "—")}</td>
        <td>${t.type === "income" ? esc(t.amountFormatted) : "—"}</td>
        <td>${t.type === "expense" ? esc(t.amountFormatted) : "—"}</td>
      </tr>`).join("");
    area.innerHTML = `
      <p class="fin-print-title">${title}</p>
      <p class="fin-print-subtitle">${subtitle}</p>
      <table class="fin-print-table">
        <thead><tr><th>رقم العملية</th><th>التاريخ والوقت</th><th>عنوان العملية</th><th>النوع</th><th>جهة الصرف</th><th>مداخيل</th><th>مدفوعات</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="fin-print-totals">
        إجمالي المداخيل: ${esc(report.totalIncomeFormatted)} &nbsp; | &nbsp;
        إجمالي المدفوعات: ${esc(report.totalExpenseFormatted)} &nbsp; | &nbsp;
        الرصيد: ${esc(report.balanceFormatted)}
      </p>`;

    const orientation = document.getElementById("r-orientation") ? document.getElementById("r-orientation").value : "portrait";
    let styleTag = document.getElementById("fin-print-orientation");
    if (!styleTag) { styleTag = document.createElement("style"); styleTag.id = "fin-print-orientation"; document.head.appendChild(styleTag); }
    styleTag.textContent = `@page { size: A4 ${orientation}; margin: 14mm; }`;

    document.body.classList.add("fin-printing");
    const cleanup = () => { document.body.classList.remove("fin-printing"); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    window.print();
  }

  Pages["#/reports"] = async function (user) {
    const content = document.getElementById("fin-content");
    const { years, activeFinancialYearId } = await api("/finance/years");
    const activeYear = years.find((y) => y.id === activeFinancialYearId);
    const activeYearLabel = activeYear ? String(activeYear.year) : "—";
    content.innerHTML = `
      <p class="fin-section-title">التقارير المالية</p>
      <div class="fin-panel">
        <div class="fin-filters">
          <div class="fin-field"><label>نطاق التقرير</label>
            <select id="r-scope">
              <option value="year">السنة المالية كاملة (${esc(activeYearLabel)})</option>
              <option value="month">شهر محدد</option>
              <option value="custom">فترة مخصصة</option>
            </select></div>
          <div class="fin-field" id="r-month-field" style="display:none;"><label>الشهر</label><input id="r-month" type="month"></div>
          <div class="fin-field" id="r-from-field" style="display:none;"><label>من تاريخ</label><input id="r-from" type="date"></div>
          <div class="fin-field" id="r-to-field" style="display:none;"><label>إلى تاريخ</label><input id="r-to" type="date"></div>
          <div class="fin-field"><label>اتجاه الطباعة</label>
            <select id="r-orientation">
              <option value="portrait">📄 عمودي Portrait</option>
              <option value="landscape">📄 أفقي Landscape</option>
            </select></div>
        </div>
        <div class="fin-form-actions"><button class="fin-btn fin-btn-primary fin-btn-sm" id="r-run">📊 إنشاء التقرير</button></div>
      </div>
      <div id="r-results"></div>`;

    const scopeSelect = document.getElementById("r-scope");
    function syncScopeFields() {
      document.getElementById("r-month-field").style.display = scopeSelect.value === "month" ? "" : "none";
      document.getElementById("r-from-field").style.display = scopeSelect.value === "custom" ? "" : "none";
      document.getElementById("r-to-field").style.display = scopeSelect.value === "custom" ? "" : "none";
    }
    scopeSelect.addEventListener("change", syncScopeFields);
    syncScopeFields();

    let lastReport = null, lastTitle = "", lastSubtitle = "";

    document.getElementById("r-run").addEventListener("click", async () => {
      const scopeMode = scopeSelect.value;
      let dateFrom, dateTo, scope;
      if (scopeMode === "year") {
        // No date range needed — buildFinancialReport already scopes to the
        // active financial year by financialYearId, which is the correct
        // and complete boundary (not a Jan1–Dec31 assumption that could
        // miss a transaction dated outside the calendar year by mistake).
        dateFrom = undefined;
        dateTo = undefined;
        scope = { mode: "year" };
      } else if (scopeMode === "month") {
        const monthVal = document.getElementById("r-month").value; // "YYYY-MM"
        if (!monthVal) { toast("اختر الشهر أولاً", "error"); return; }
        const [y, m] = monthVal.split("-").map(Number);
        dateFrom = `${monthVal}-01`;
        dateTo = new Date(y, m, 0).toISOString().slice(0, 10);
        scope = { mode: "month", month: monthVal };
      } else {
        dateFrom = document.getElementById("r-from").value;
        dateTo = document.getElementById("r-to").value;
        if (!dateFrom || !dateTo) { toast("حدد تاريخ البداية والنهاية", "error"); return; }
        scope = { mode: "custom", from: dateFrom, to: dateTo };
      }
      const params = { period: "custom", dateFrom, dateTo };
      const report = await api("/finance/reports/financial" + qs(params));
      lastReport = report;
      lastTitle = buildReportTitle(scope, activeYearLabel);
      lastSubtitle = scope.mode === "year"
        ? `السنة المالية: ${esc(activeYearLabel)}`
        : `الفترة: ${dateFrom || "البداية"} إلى ${dateTo || "اليوم"}`;

      document.getElementById("r-results").innerHTML = `
        <div class="fin-cards">
          <div class="fin-card income"><div class="fin-card-label">إجمالي المداخيل (${report.incomeCount})</div><div class="fin-card-value">${esc(report.totalIncomeFormatted)}</div></div>
          <div class="fin-card expense"><div class="fin-card-label">إجمالي المصاريف (${report.expenseCount})</div><div class="fin-card-value">${esc(report.totalExpenseFormatted)}</div></div>
          <div class="fin-card balance"><div class="fin-card-label">الرصيد</div><div class="fin-card-value">${esc(report.balanceFormatted)}</div></div>
        </div>
        <div class="fin-panel">
          <div class="fin-panel-title">إجمالي المصاريف حسب جهة الصرف
            <div style="display:flex;gap:8px;">
              <button class="fin-btn fin-btn-ghost fin-btn-sm" id="r-export-excel">⬇️ Excel</button>
              <button class="fin-btn fin-btn-ghost fin-btn-sm" id="r-export-pdf">⬇️ PDF</button>
              <button class="fin-btn fin-btn-ghost fin-btn-sm" id="r-print-btn">🖨️ طباعة</button>
            </div>
          </div>
          ${report.byCategory.length ? `<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>جهة الصرف</th><th>عدد العمليات</th><th>الإجمالي</th></tr></thead>
            <tbody>${report.byCategory.map((c) => `<tr><td>${esc(c.categoryName)}</td><td>${c.count}</td><td class="fin-amount-expense">${esc(c.totalFormatted)}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="fin-muted">لا توجد مصاريف في هذه الفترة.</p>`}
        </div>
        <div class="fin-panel"><div class="fin-panel-title">${esc(lastTitle)}</div>${renderTxnTable(report.transactions)}</div>`;
      wireTableRowClicks(document.getElementById("r-results"), user);
      document.getElementById("r-export-excel").addEventListener("click", () => downloadExport("excel", params));
      document.getElementById("r-export-pdf").addEventListener("click", () => downloadExport("pdf", params));
      document.getElementById("r-print-btn").addEventListener("click", () => printFinancialReport(lastReport, lastTitle, lastSubtitle));
    });
  };

  // ---- Categories (admin only) ----
  Pages["#/categories"] = async function (user) {
    const content = document.getElementById("fin-content");
    async function refresh() {
      const categories = await loadCategories();
      content.innerHTML = `
        <p class="fin-section-title">جهات الصرف</p>
        <p class="fin-section-sub">تُستخدم كوجهات لعمليات الخروج، ويمكن إضافة جهات جديدة أو تعطيلها.</p>
        <div class="fin-panel">
          <div class="fin-panel-title">إضافة جهة صرف جديدة</div>
          <form id="cat-form">
            <div class="fin-grid-2">
              <div class="fin-field"><label>الاسم *</label><input name="name" required></div>
              <div class="fin-field"><label>الوصف</label><input name="description"></div>
            </div>
            <div class="fin-form-actions"><button class="fin-btn fin-btn-primary fin-btn-sm" type="submit">إضافة ✓</button></div>
          </form>
        </div>
        <div class="fin-panel">
          <div class="fin-panel-title">القائمة (${categories.length})</div>
          ${categories.length ? `<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>الاسم</th><th>الوصف</th><th>الحالة</th><th>—</th></tr></thead>
            <tbody>${categories.map((c) => `<tr>
              <td>${esc(c.name)}</td><td>${esc(c.description || "—")}</td>
              <td><span class="fin-badge ${c.status}">${c.status === "active" ? "مفعّلة" : "معطّلة"}</span></td>
              <td><button class="fin-btn fin-btn-ghost fin-btn-sm" data-toggle="${c.id}" data-status="${c.status}">${c.status === "active" ? "تعطيل" : "تفعيل"}</button>
                  <button class="fin-btn fin-btn-danger fin-btn-sm" data-del="${c.id}">حذف</button></td>
            </tr>`).join("")}</tbody></table></div>` : `<div class="fin-empty">لا توجد جهات صرف بعد</div>`}
        </div>`;

      document.getElementById("cat-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await api("/finance/categories", { method: "POST", body: { name: fd.get("name"), description: fd.get("description") } });
          toast("تمت إضافة جهة الصرف بنجاح ✓");
          refresh();
        } catch (err) { toast(err.message || "تعذّر الحفظ ✕", "error"); }
      });
      content.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
        const nextStatus = b.getAttribute("data-status") === "active" ? "disabled" : "active";
        try { await api(`/finance/categories/${b.getAttribute("data-toggle")}`, { method: "PUT", body: { status: nextStatus } }); toast("تم التحديث ✓"); refresh(); }
        catch (err) { toast(err.message, "error"); }
      }));
      content.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("هل أنت متأكد من حذف جهة الصرف هذه؟")) return;
        try { await api(`/finance/categories/${b.getAttribute("data-del")}`, { method: "DELETE" }); toast("تم الحذف ✓"); refresh(); }
        catch (err) { toast(err.message, "error"); }
      }));
    }
    refresh();
  };

  // ---- Financial years (السنوات المالية) ----
  // Available to all finance roles for viewing/switching; create/edit/
  // disable/delete restricted to admin (enforced again server-side).
  Pages["#/years"] = async function (user) {
    const content = document.getElementById("fin-content");
    const isAdmin = user.role === "admin";
    async function refresh() {
      const { years, activeFinancialYearId } = await api("/finance/years");
      content.innerHTML = `
        <p class="fin-section-title">السنوات المالية</p>
        <p class="fin-section-sub">كل سنة مالية مستقلة تمامًا عن باقي السنوات — العمليات، الأرصدة، الإحصائيات، والتقارير الخاصة بكل سنة معزولة تمامًا عن السنوات الأخرى.</p>
        ${isAdmin ? `
        <div class="fin-panel">
          <div class="fin-panel-title">إنشاء سنة مالية جديدة</div>
          <form id="year-form">
            <div class="fin-grid-2">
              <div class="fin-field"><label>السنة المالية *</label><input name="year" type="number" required placeholder="مثال: 2026" value="${new Date().getFullYear()}"></div>
              <div class="fin-field"><label>الرصيد الافتتاحي (دج) *</label><input name="openingBalance" type="number" step="0.01" min="0" required placeholder="0.00"></div>
            </div>
            <div class="fin-hint">بعد الإنشاء، ستصبح هذه السنة هي السنة المالية النشطة تلقائيًا.</div>
            <div class="fin-error" id="year-form-error"></div>
            <div class="fin-form-actions"><button class="fin-btn fin-btn-primary fin-btn-sm" type="submit">إنشاء السنة المالية ✓</button></div>
          </form>
        </div>` : ""}
        <div class="fin-panel">
          <div class="fin-panel-title">القائمة (${years.length})</div>
          ${years.length ? `<div class="fin-table-wrap"><table class="fin-table">
            <thead><tr><th>السنة</th><th>الرصيد الافتتاحي</th><th>إجمالي المداخيل</th><th>إجمالي المدفوعات</th><th>الرصيد الحالي</th><th>عدد العمليات</th><th>الحالة</th><th>—</th></tr></thead>
            <tbody>${years.map((y) => `<tr>
              <td>${esc(String(y.year))} ${y.id === activeFinancialYearId ? '<span class="fin-badge active">نشطة</span>' : ""}</td>
              <td>${esc(y.openingBalanceFormatted)}</td>
              <td class="fin-amount-income">${esc(y.totalIncomeFormatted)}</td>
              <td class="fin-amount-expense">${esc(y.totalExpenseFormatted)}</td>
              <td><b>${esc(y.balanceFormatted)}</b></td>
              <td>${y.transactionCount}</td>
              <td><span class="fin-badge ${y.status === "active" ? "active" : "disabled"}">${y.status === "active" ? "مفعّلة" : "معطّلة"}</span></td>
              <td>
                ${y.id !== activeFinancialYearId ? `<button class="fin-btn fin-btn-ghost fin-btn-sm" data-activate="${y.id}">تفعيل</button>` : ""}
                ${isAdmin ? `<button class="fin-btn fin-btn-ghost fin-btn-sm" data-toggle-year="${y.id}" data-status="${y.status}">${y.status === "active" ? "تعطيل" : "إعادة تفعيل"}</button>` : ""}
                ${isAdmin && y.transactionCount === 0 ? `<button class="fin-btn fin-btn-ghost fin-btn-sm" data-del-year="${y.id}">حذف</button>` : ""}
              </td>
            </tr>`).join("")}</tbody>
          </table></div>` : `<div class="fin-empty">لا توجد سنوات مالية بعد — أنشئ أول سنة مالية أعلاه لبدء تسجيل العمليات.</div>`}
        </div>`;

      const yearForm = document.getElementById("year-form");
      if (yearForm) yearForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const errBox = document.getElementById("year-form-error");
        errBox.textContent = "";
        try {
          await api("/finance/years", { method: "POST", body: { year: fd.get("year"), openingBalance: fd.get("openingBalance") } });
          toast("تم إنشاء السنة المالية وتفعيلها ✓");
          render();
        } catch (err) { errBox.textContent = err.message || "تعذّر إنشاء السنة المالية ✕"; }
      });
      content.querySelectorAll("[data-activate]").forEach((b) => b.addEventListener("click", async () => {
        try { await api(`/finance/years/${b.getAttribute("data-activate")}/activate`, { method: "POST" }); toast("تم التبديل إلى هذه السنة المالية ✓"); render(); }
        catch (err) { toast(err.message, "error"); }
      }));
      content.querySelectorAll("[data-toggle-year]").forEach((b) => b.addEventListener("click", async () => {
        const next = b.getAttribute("data-status") === "active" ? "disabled" : "active";
        try { await api(`/finance/years/${b.getAttribute("data-toggle-year")}`, { method: "PUT", body: { status: next } }); toast("تم التحديث ✓"); refresh(); }
        catch (err) { toast(err.message, "error"); }
      }));
      content.querySelectorAll("[data-del-year]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("هل أنت متأكد من حذف هذه السنة المالية؟")) return;
        try { await api(`/finance/years/${b.getAttribute("data-del-year")}`, { method: "DELETE" }); toast("تم الحذف ✓"); render(); }
        catch (err) { toast(err.message, "error"); }
      }));
    }
    refresh();
  };

  // ---- Settings (admin only) ----
  Pages["#/settings"] = async function () {
    const content = document.getElementById("fin-content");
    const s = (await api("/finance/settings")).settings;
    content.innerHTML = `
      <p class="fin-section-title">إعدادات النظام المالي</p>
      <div class="fin-panel">
        <form id="settings-form">
          <div class="fin-grid-2">
            <div class="fin-field"><label>اسم الرابطة بالعربية</label><input name="ligueNameAr" value="${esc(s.ligueNameAr)}"></div>
            <div class="fin-field"><label>اسم الرابطة بالفرنسية</label><input name="ligueNameFr" value="${esc(s.ligueNameFr)}"></div>
          </div>
          <div class="fin-grid-2">
            <div class="fin-field"><label>عدد خانات ترقيم العمليات</label><input name="numberingPadding" type="number" min="4" max="10" value="${s.numberingPadding}"></div>
            <div class="fin-field"><label>العملة</label><input name="currency" value="${esc(s.currency)}"></div>
          </div>
          <div class="fin-field"><label><input type="checkbox" name="enforceNoOverdraft" ${s.enforceNoOverdraft ? "checked" : ""}> منع تسجيل مصاريف تتجاوز الرصيد المتاح</label></div>
          <div class="fin-form-actions"><button class="fin-btn fin-btn-primary" type="submit">حفظ الإعدادات ✓</button></div>
        </form>
      </div>
      <div class="fin-panel">
        <div class="fin-panel-title">شعار الرابطة</div>
        ${s.logoUrl ? `<img src="${s.logoUrl}" style="max-width:120px;border-radius:10px;margin-bottom:10px;display:block;">` : `<p class="fin-muted">لم يتم رفع شعار بعد.</p>`}
        <form id="logo-form" enctype="multipart/form-data">
          <input type="file" name="logo" accept="image/png,image/jpeg,image/webp" required>
          <div class="fin-form-actions"><button class="fin-btn fin-btn-ghost fin-btn-sm" type="submit">رفع الشعار</button></div>
        </form>
      </div>`;
    document.getElementById("settings-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api("/finance/settings", { method: "PUT", body: {
          ligueNameAr: fd.get("ligueNameAr"), ligueNameFr: fd.get("ligueNameFr"),
          numberingPadding: fd.get("numberingPadding"), currency: fd.get("currency"),
          enforceNoOverdraft: fd.get("enforceNoOverdraft") === "on",
        } });
        toast("تم حفظ الإعدادات ✓");
      } catch (err) { toast(err.message, "error"); }
    });
    document.getElementById("logo-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api("/finance/settings/logo", { method: "POST", body: new FormData(e.target), isForm: true }); toast("تم رفع الشعار ✓"); Pages["#/settings"](); }
      catch (err) { toast(err.message, "error"); }
    });
  };

  // ---- Finance users (admin only) ----
  Pages["#/users"] = async function () {
    const content = document.getElementById("fin-content");
    async function refresh() {
      const { users } = await api("/finance/users");
      const roleLabel = { admin: "مدير النظام", finance_admin: "المسؤول المالي", finance_viewer: "مستخدم للعرض" };
      content.innerHTML = `
        <p class="fin-section-title">مستخدمو النظام المالي</p>
        <div class="fin-panel">
          <div class="fin-panel-title">إضافة مستخدم جديد</div>
          <form id="user-form">
            <div class="fin-grid-2">
              <div class="fin-field"><label>الاسم الكامل *</label><input name="fullNameAr" required></div>
              <div class="fin-field"><label>اسم المستخدم *</label><input name="username" required></div>
            </div>
            <div class="fin-grid-2">
              <div class="fin-field"><label>كلمة المرور *</label><input name="password" type="password" required minlength="6"></div>
              <div class="fin-field"><label>الدور *</label><select name="role"><option value="finance_admin">المسؤول المالي</option><option value="finance_viewer">مستخدم للعرض</option></select></div>
            </div>
            <div class="fin-form-actions"><button class="fin-btn fin-btn-primary fin-btn-sm" type="submit">إضافة ✓</button></div>
          </form>
        </div>
        <div class="fin-panel">
          <div class="fin-panel-title">القائمة (${users.length})</div>
          <div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>الحالة</th><th>—</th></tr></thead>
          <tbody>${users.map((u) => `<tr data-userid="${u.id}">
            <td>
              <span class="fu-view">${esc(u.fullNameAr)}</span>
              <input class="fu-edit" data-field="fullNameAr" style="display:none;width:100%;" value="${esc(u.fullNameAr)}">
            </td>
            <td>
              <span class="fu-view">${esc(u.username)}</span>
              <input class="fu-edit" data-field="username" style="display:none;width:100%;" dir="ltr" value="${esc(u.username)}">
            </td>
            <td>${roleLabel[u.role] || u.role}</td>
            <td><span class="fin-badge ${u.status === "active" ? "active" : "disabled"}">${u.status === "active" ? "مفعّل" : "معطّل"}</span></td>
            <td>${u.role !== "admin" ? `
              <span class="fu-view-actions">
                <button class="fin-btn fin-btn-ghost fin-btn-sm" data-edit-user-start="${u.id}">✏️ تعديل</button>
                <button class="fin-btn fin-btn-ghost fin-btn-sm" data-toggle-user="${u.id}" data-status="${u.status}">${u.status === "active" ? "تعطيل" : "تفعيل"}</button>
                <button class="fin-btn fin-btn-ghost fin-btn-sm" data-del-user="${u.id}">🗑 حذف</button>
              </span>
              <span class="fu-edit-actions" style="display:none;">
                <input class="fu-edit" data-field="password" type="password" placeholder="كلمة مرور جديدة (اختياري)" style="display:block;width:100%;margin-bottom:6px;">
                <button class="fin-btn fin-btn-primary fin-btn-sm" data-edit-user-save="${u.id}">✓ حفظ</button>
                <button class="fin-btn fin-btn-ghost fin-btn-sm" data-edit-user-cancel="${u.id}">✕ إلغاء</button>
              </span>` : ""}</td>
          </tr>`).join("")}</tbody></table></div>
        </div>`;
      document.getElementById("user-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await api("/finance/users", { method: "POST", body: { fullNameAr: fd.get("fullNameAr"), username: fd.get("username"), password: fd.get("password"), role: fd.get("role") } });
          toast("تمت إضافة المستخدم بنجاح ✓");
          refresh();
        } catch (err) { toast(err.message, "error"); }
      });
      content.querySelectorAll("[data-toggle-user]").forEach((b) => b.addEventListener("click", async () => {
        const next = b.getAttribute("data-status") === "active" ? "disabled" : "active";
        await api(`/finance/users/${b.getAttribute("data-toggle-user")}`, { method: "PUT", body: { status: next } }); toast("تم التحديث ✓"); refresh();
      }));
      content.querySelectorAll("[data-edit-user-start]").forEach((b) => b.addEventListener("click", () => {
        const row = b.closest("tr");
        row.querySelectorAll(".fu-view").forEach((el) => el.style.display = "none");
        row.querySelectorAll(".fu-edit").forEach((el) => el.style.display = "block");
        row.querySelector(".fu-view-actions").style.display = "none";
        row.querySelector(".fu-edit-actions").style.display = "block";
      }));
      content.querySelectorAll("[data-edit-user-cancel]").forEach((b) => b.addEventListener("click", refresh));
      content.querySelectorAll("[data-edit-user-save]").forEach((b) => b.addEventListener("click", async () => {
        const row = b.closest("tr");
        const userId = b.getAttribute("data-edit-user-save");
        const body = {};
        row.querySelectorAll(".fu-edit").forEach((el) => {
          const field = el.getAttribute("data-field");
          if (field === "password") { if (el.value.trim()) body.password = el.value.trim(); }
          else body[field] = el.value.trim();
        });
        try { await api(`/finance/users/${userId}`, { method: "PUT", body }); toast("تم التحديث ✓"); refresh(); }
        catch (err) { toast(err.message, "error"); }
      }));
      content.querySelectorAll("[data-del-user]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("هل تريد حذف هذا المستخدم نهائيًا؟")) return;
        try { await api(`/finance/users/${b.getAttribute("data-del-user")}`, { method: "DELETE" }); toast("تم الحذف ✓"); refresh(); }
        catch (err) { toast(err.message, "error"); }
      }));
    }
    refresh();
  };

  // ---- Audit log ----
  Pages["#/audit"] = async function () {
    const content = document.getElementById("fin-content");
    const { log } = await api("/finance/audit-logs");
    content.innerHTML = `
      <p class="fin-section-title">سجل التدقيق</p>
      <p class="fin-section-sub">سجل بجميع العمليات الحساسة في النظام المالي — للقراءة فقط.</p>
      <div class="fin-panel">
        ${log.length ? `<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>التاريخ والوقت</th><th>المستخدم</th><th>الإجراء</th></tr></thead>
        <tbody>${log.map((e) => `<tr><td>${new Date(e.at).toLocaleString("ar-DZ")}</td><td>${esc(e.userName || "—")}</td><td style="text-align:right">${esc(e.summary || e.action)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="fin-empty">لا توجد عناصر في سجل التدقيق بعد</div>`}
      </div>`;
  };

  // ============================================================
  // Boot / render
  // ============================================================
  // Pages that operate on financial data and therefore require an active
  // financial year to be selected first (per "أولاً" in the brief: no
  // financial operation runs before a financial year is chosen). Pages not
  // in this list (السنوات المالية itself, جهات الصرف, المستخدمون,
  // الإعدادات, سجل التدقيق) are year-independent.
  const YEAR_SCOPED_ROUTES = ["#/dashboard", "#/transactions/manage", "#/transactions", "#/reports"];

  async function render() {
    const session = getSession();
    if (!session || !session.user || !["admin", "finance_admin", "finance_viewer"].includes(session.user.role)) {
      renderLogin();
      return;
    }
    let route = currentRoute();
    if (!Pages[route]) route = "#/dashboard";
    const navRoles = (NAV_ITEMS.find((n) => n.hash === route) || {}).roles || [];
    if (navRoles.length && !navRoles.includes(session.user.role)) route = "#/dashboard";

    let years = [], activeFinancialYearId = null;
    try {
      const yearsRes = await api("/finance/years");
      years = yearsRes.years;
      activeFinancialYearId = yearsRes.activeFinancialYearId;
    } catch (err) { /* shown per-page below */ }

    if (YEAR_SCOPED_ROUTES.includes(route) && !activeFinancialYearId) {
      mountShell(session.user, years, activeFinancialYearId);
      document.getElementById("fin-header-title").textContent = "السنوات المالية";
      document.getElementById("fin-content").innerHTML = `<div class="fin-empty">
        لا توجد سنة مالية نشطة بعد. يجب إنشاء سنة مالية وتحديد رصيدها الافتتاحي قبل تسجيل أو عرض أي عملية مالية.
        <br><br><a href="#/years" class="fin-btn fin-btn-primary fin-btn-sm">إنشاء سنة مالية جديدة</a>
      </div>`;
      return;
    }

    mountShell(session.user, years, activeFinancialYearId);
    document.getElementById("fin-header-title").textContent = (NAV_ITEMS.find((n) => n.hash === route) || {}).label || "النظام المالي";
    try {
      await Pages[route](session.user);
    } catch (err) {
      document.getElementById("fin-content").innerHTML = `<div class="fin-empty">تعذّر تحميل الصفحة: ${esc(err.message)}</div>`;
    }
  }

  render();
})();
