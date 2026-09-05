// settingsCore.js — small shared helpers for the "registration open/closed"
// system-settings feature. Kept in its own module (like chatCore.js) so
// routes/settings.js, routes/admin.js and routes/auth.js can all use the
// exact same open/closed logic without importing each other.

const REGISTRATION_MODES = { ALWAYS_OPEN: "always_open", TIMER: "timer" };

// ---- Whole-platform kill switch ("حالة الموقع") — independent of the
// registration open/closed setting above. When off, every non-admin
// account is locked out of login, signup, and every API route (enforced
// in middleware/auth.js, not just hidden in the UI — see the comment
// there). The admin account is always exempt, in every case, so the
// platform can always be re-enabled. ----
const SITE_DISABLED_MESSAGE = "المنصة غير متاحة حاليًا، يرجى المحاولة لاحقًا.";

const DEFAULT_SETTINGS = {
  is_registration_open: true,
  registration_mode: REGISTRATION_MODES.ALWAYS_OPEN,
  registration_deadline: null,
  site_enabled: true,
};

// Always returns a full, well-shaped settings object — merges whatever is
// stored on the platform document over the defaults, so older data (or a
// freshly-seeded database with no `settings` key at all) never crashes
// anything downstream.
function getSettings(data) {
  const stored = (data && data.settings) || {};
  return {
    is_registration_open: typeof stored.is_registration_open === "boolean" ? stored.is_registration_open : DEFAULT_SETTINGS.is_registration_open,
    registration_mode: stored.registration_mode === REGISTRATION_MODES.TIMER ? REGISTRATION_MODES.TIMER : REGISTRATION_MODES.ALWAYS_OPEN,
    registration_deadline: stored.registration_deadline || null,
    site_enabled: typeof stored.site_enabled === "boolean" ? stored.site_enabled : DEFAULT_SETTINGS.site_enabled,
  };
}

// The single source of truth for "is the platform enabled right now?".
function isSiteEnabled(settings) {
  return settings.site_enabled !== false;
}

// The single source of truth for "is registration open right now?" — used
// both to gate POST /api/auth/signup on the server and to decide what the
// home page should render on the client.
function isRegistrationOpen(settings) {
  if (!settings.is_registration_open) return false;
  if (settings.registration_mode === REGISTRATION_MODES.TIMER) {
    if (!settings.registration_deadline) return true; // timer mode chosen but no deadline set yet — treat as open
    return new Date(settings.registration_deadline).getTime() > Date.now();
  }
  return true;
}

module.exports = { REGISTRATION_MODES, DEFAULT_SETTINGS, getSettings, isRegistrationOpen, isSiteEnabled, SITE_DISABLED_MESSAGE };
