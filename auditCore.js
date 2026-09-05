// auditCore.js — professional Audit Log for every change made to a
// referee's core data, regardless of WHO made it (the referee themselves,
// the admin editing directly, or an approved "طلب تعديل معلومة").
//
// This is the single place new entries are created and read from, so the
// shape of an entry never drifts between the different write-sites that
// call it (routes/applications.js self-edit, routes/admin.js direct edit,
// routes/admin.js edit-request approval).
//
// Entry shape (see FIELD_LABELS below for human-readable Arabic labels):
// {
//   id, at (ISO string),
//   userId          — the referee whose data changed
//   field           — the raw field key (e.g. "fullNameAr", "phone1")
//   fieldLabel      — human-readable Arabic label for the field
//   oldValue, newValue,
//   changedBy       — "admin" | "referee"
//   changedByUserId — the acting user's id (admin id or the referee's own id)
//   changedByName   — display name of the acting user at the time of the change
//   reason          — free-text reason (admin's note on a direct edit, or the
//                      referee's stated reason on an approved edit request)
//   source          — "self_edit" | "admin_edit" | "edit_request" | "system_sync"
//   accountStatusBefore / accountStatusAfter — snapshot of the account's
//     review status at the moment of the change (useful for audits: was this
//     edited while pending review, needing correction, after activation…)
// }

const { v4: uuidv4 } = require("uuid");

let FIELD_GROUPS;
try {
  // Lazy require to avoid a circular dependency with schema.js at module
  // load time (schema.js does not require this file, but keeping this
  // defensive is cheap).
  ({ FIELD_GROUPS } = require("./schema"));
} catch (e) {
  FIELD_GROUPS = [];
}

const FIELD_LABELS = { username: "اسم المستخدم", email: "البريد الإلكتروني", phone: "رقم الهاتف" };
(FIELD_GROUPS || []).forEach((g) => g.fields.forEach((f) => { FIELD_LABELS[f.key] = f.label; }));

function labelFor(field) {
  return FIELD_LABELS[field] || field;
}

// Adds one audit entry. `data` is the full platform-state object (the
// caller is responsible for calling db.saveAll(data) afterwards, exactly
// like every other mutation in this project).
function addAuditEntry(data, entry) {
  if (!Array.isArray(data.auditLog)) data.auditLog = [];
  const full = {
    id: uuidv4(),
    at: new Date().toISOString(),
    userId: entry.userId,
    field: entry.field,
    fieldLabel: entry.fieldLabel || labelFor(entry.field),
    oldValue: entry.oldValue === undefined ? null : entry.oldValue,
    newValue: entry.newValue === undefined ? null : entry.newValue,
    changedBy: entry.changedBy || "admin",
    changedByUserId: entry.changedByUserId || null,
    changedByName: entry.changedByName || null,
    reason: entry.reason || null,
    source: entry.source || "admin_edit",
    accountStatusBefore: entry.accountStatusBefore || null,
    accountStatusAfter: entry.accountStatusAfter || null,
  };
  data.auditLog.push(full);
  return full;
}

// Records a batch of {field, oldValue, newValue} diffs in one call — used
// by every write-site below so a single "save" produces one audit entry per
// field actually changed (unchanged fields are never logged).
function addAuditEntries(data, userId, diffs, common) {
  return diffs
    .filter((d) => String(d.oldValue ?? "") !== String(d.newValue ?? ""))
    .map((d) => addAuditEntry(data, { ...common, userId, field: d.field, fieldLabel: d.fieldLabel, oldValue: d.oldValue, newValue: d.newValue }));
}

function getAuditLog(data, { userId } = {}) {
  const list = Array.isArray(data.auditLog) ? data.auditLog : [];
  const filtered = userId ? list.filter((e) => e.userId === userId) : list;
  return filtered.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
}

module.exports = { addAuditEntry, addAuditEntries, getAuditLog, labelFor };
