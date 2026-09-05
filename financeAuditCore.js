// financeAuditCore.js — Audit Log for the finance module (section 18/31 of
// the brief). Deliberately separate from auditCore.js, which tracks
// field-level edits to a REFEREE's registration data — the finance ledger
// is a different domain with a different, simpler entry shape:
//
// { id, at, userId, userName, userRole, action, entity, entityId, oldData, newData }
//
// `action` is one of the values in FINANCE_ACTIONS below. `entity` names
// which kind of record changed ("transaction" | "category" | "financial_year" |
// "settings" | "financeUser"). oldData/newData are plain snapshots (not
// diffs) — enough to reconstruct "what changed" without depending on this
// file knowing every field of every entity type.
//
// Regular users of the finance module (finance_admin, finance_viewer) can
// never delete or edit entries here — only routes/finance.js's read
// endpoint exposes this log, and only to admin/finance_admin.

const { v4: uuidv4 } = require("uuid");

const FINANCE_ACTIONS = {
  LOGIN: "login",
  CREATE_TRANSACTION: "create_transaction",
  UPDATE_TRANSACTION: "update_transaction",
  DELETE_TRANSACTION: "delete_transaction",
  CREATE_CATEGORY: "create_category",
  UPDATE_CATEGORY: "update_category",
  DISABLE_CATEGORY: "disable_category",
  DELETE_CATEGORY: "delete_category",
  CREATE_FINANCIAL_YEAR: "create_financial_year",
  UPDATE_FINANCIAL_YEAR: "update_financial_year",
  DELETE_FINANCIAL_YEAR: "delete_financial_year",
  ACTIVATE_FINANCIAL_YEAR: "activate_financial_year",
  UPDATE_SETTINGS: "update_settings",
  CREATE_FINANCE_USER: "create_finance_user",
  UPDATE_FINANCE_USER: "update_finance_user",
  DISABLE_FINANCE_USER: "disable_finance_user",
  DELETE_FINANCE_USER: "delete_finance_user",
};

function addFinanceAuditEntry(data, entry) {
  if (!Array.isArray(data.financeAuditLog)) data.financeAuditLog = [];
  const full = {
    id: uuidv4(),
    at: new Date().toISOString(),
    userId: entry.userId || null,
    userName: entry.userName || null,
    userRole: entry.userRole || null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId || null,
    oldData: entry.oldData === undefined ? null : entry.oldData,
    newData: entry.newData === undefined ? null : entry.newData,
    summary: entry.summary || null,
  };
  data.financeAuditLog.push(full);
  return full;
}

function getFinanceAuditLog(data, { entity, entityId, userId, dateFrom, dateTo } = {}) {
  let list = Array.isArray(data.financeAuditLog) ? data.financeAuditLog : [];
  if (entity) list = list.filter((e) => e.entity === entity);
  if (entityId) list = list.filter((e) => e.entityId === entityId);
  if (userId) list = list.filter((e) => e.userId === userId);
  if (dateFrom) list = list.filter((e) => e.at >= dateFrom);
  if (dateTo) list = list.filter((e) => e.at <= dateTo);
  return list.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
}

module.exports = { FINANCE_ACTIONS, addFinanceAuditEntry, getFinanceAuditLog };
