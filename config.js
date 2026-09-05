require("dotenv").config();

module.exports = {
  // Different default port than the referee-platform project (4000) so the
  // two can run side by side on the same machine during development.
  PORT: process.env.PORT || 4001,
  // Only needs to match the referee-platform project's JWT_SECRET if you
  // want a token minted by one project to also be accepted by the other
  // (not required — each project only ever verifies tokens against its own
  // secret, since login now happens separately on each site).
  JWT_SECRET: process.env.JWT_SECRET || "lwf-eloued-change-this-secret-in-production",
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "LWF@2026",
  MAX_UPLOAD_MB: 8,

  // MongoDB Atlas — persistent database (replaces the old local db.json file)
  MONGODB_URI: process.env.MONGODB_URI || "",

  // Cloudinary — persistent file storage (replaces the old local uploads/ folder)
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
};
