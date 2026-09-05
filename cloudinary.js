// cloudinary.js — persistent file storage for uploaded referee documents.
// Replaces the old local uploads/ folder, which does not survive on
// serverless/ephemeral hosting (Render free tier, Vercel, etc.).

const cloudinary = require("cloudinary").v2;
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = require("./config");

if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function isConfigured() {
  return Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

// Uploads a Buffer (from multer's memoryStorage) straight to Cloudinary.
function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "lwf-referees", resource_type: "auto", ...options },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// Best-effort delete of a previous asset (e.g. when a referee re-uploads a document).
async function destroyAsset(publicId, resourceType) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || "image" });
  } catch (e) {
    // Non-fatal: an orphaned old asset is not worth failing the request over.
    console.error("تعذّر حذف الملف القديم من Cloudinary:", e.message);
  }
}

module.exports = { isConfigured, uploadBuffer, destroyAsset };
