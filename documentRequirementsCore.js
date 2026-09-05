// documentRequirementsCore.js — dynamic "which documents must a referee
// upload" list, fully managed by the admin (Section: إدارة وثائق الانخراط).
//
// Replaces the old hardcoded DOC_TYPES in schema.js. The IDs of the seed
// requirements below are kept identical to the old hardcoded keys
// ("photo", "birthCert", "idCard", "qualification", "ccpDoc") on purpose:
// application.documents / application.docFlags are plain objects keyed by
// requirement id, so any application created before this feature existed
// keeps working unchanged after the upgrade. The admin is free to edit,
// remove, or add to this seed list from the new admin panel afterwards.
//
// A requirement that isRequired=false is optional: referees may upload it,
// but submitting the application does not require it. hasTemplate=true
// means the admin has attached a downloadable/printable PDF template
// (e.g. a medical exam form) that the referee must download, fill in by
// hand, and re-upload as their document.

const { v4: uuidv4 } = require("uuid");

const SEED_DOCUMENT_REQUIREMENTS = [
  { id: "photo", title: "الصورة الشمسية", description: "", icon: "🪪", isRequired: true, hasTemplate: false, templateUrl: "", templatePublicId: "", templateOriginalName: "" },
  { id: "birthCert", title: "شهادة الميلاد", description: "", icon: "📄", isRequired: true, hasTemplate: false, templateUrl: "", templatePublicId: "", templateOriginalName: "" },
  { id: "idCard", title: "نسخة من بطاقة التعريف", description: "", icon: "🆔", isRequired: true, hasTemplate: false, templateUrl: "", templatePublicId: "", templateOriginalName: "" },
  { id: "qualification", title: "نسخة من المؤهل العلمي", description: "", icon: "🎓", isRequired: true, hasTemplate: false, templateUrl: "", templatePublicId: "", templateOriginalName: "" },
  { id: "ccpDoc", title: "نسخة من صك بريدي (CCP)", description: "", icon: "💳", isRequired: true, hasTemplate: false, templateUrl: "", templatePublicId: "", templateOriginalName: "" },
];

function seedDocumentRequirements() {
  return SEED_DOCUMENT_REQUIREMENTS.map((d, i) => ({ ...d, order: i, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
}

// Public shape returned to referees/admins from GET /api/document-requirements
// (strips internal Cloudinary bookkeeping fields the client doesn't need).
function toPublic(req) {
  return {
    id: req.id,
    title: req.title,
    description: req.description || "",
    icon: req.icon || "📎",
    isRequired: !!req.isRequired,
    hasTemplate: !!req.hasTemplate,
    templateUrl: req.hasTemplate ? req.templateUrl || "" : "",
    templateOriginalName: req.hasTemplate ? req.templateOriginalName || "" : "",
    order: typeof req.order === "number" ? req.order : 0,
  };
}

function sortedRequirements(list) {
  return [...(list || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function newRequirementId() {
  return uuidv4();
}

module.exports = { SEED_DOCUMENT_REQUIREMENTS, seedDocumentRequirements, toPublic, sortedRequirements, newRequirementId };
