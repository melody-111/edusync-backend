'use strict';

/**
 * ─── CLOUD STORAGE SERVICE (Cloudinary) ──────────────────────────────────────
 *
 * Handles uploading/downloading/deleting note canvas data to Cloudinary.
 * 
 * When CLOUD_STORAGE_ENABLED=true and valid credentials are in .env,
 * canvasData is uploaded to Cloudinary as a raw file and a URL is returned.
 *
 * When credentials are missing or CLOUD_STORAGE_ENABLED=false,
 * the service gracefully falls back — canvasData stays in MongoDB as before.
 *
 * .env keys required:
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *   CLOUD_STORAGE_ENABLED=true
 */

const cloudinary = require('cloudinary').v2;
const logger = require('../utils/logger');

// ─── Configuration ──────────────────────────────────────────────────────────

let isConfigured = false;

const CLOUD_STORAGE_ENABLED = process.env.CLOUD_STORAGE_ENABLED === 'true';

if (CLOUD_STORAGE_ENABLED) {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
      secure: true,
    });
    isConfigured = true;
    logger.info('☁️  Cloudinary cloud storage initialized successfully');
  } else {
    logger.warn('☁️  CLOUD_STORAGE_ENABLED=true but Cloudinary credentials are missing. Falling back to MongoDB storage.');
    logger.warn('   Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in .env');
  }
} else {
  logger.info('☁️  Cloud storage disabled (CLOUD_STORAGE_ENABLED != true). Notes will be stored in MongoDB.');
}

// ─── Upload ─────────────────────────────────────────────────────────────────

/**
 * Upload canvasData (JSON string) to Cloudinary.
 *
 * @param {string} canvasData  - The Fabric.js JSON string or base64 canvas data
 * @param {string} userId      - Owner's user ID (used for folder organisation)
 * @param {string} noteId      - Note/File ID (used for unique naming)
 * @returns {Promise<{ cloudUrl: string, cloudPublicId: string } | null>}
 *          Returns null if cloud storage is not configured (fallback to MongoDB)
 */
const uploadCanvasData = async (canvasData, userId, noteId) => {
  if (!isConfigured || !canvasData) return null;

  try {
    // Determine if canvasData is base64 image or JSON
    const isBase64Image = canvasData.startsWith('data:image');

    let uploadResult;

    if (isBase64Image) {
      // Upload base64 image directly
      uploadResult = await cloudinary.uploader.upload(canvasData, {
        folder: `edusync/notes/${userId}`,
        public_id: `note_${noteId}_${Date.now()}`,
        resource_type: 'image',
        overwrite: true,
        invalidate: true,
      });
    } else {
      // Upload JSON/text data as raw file using data URI
      const base64Encoded = Buffer.from(canvasData, 'utf-8').toString('base64');
      const dataUri = `data:application/json;base64,${base64Encoded}`;

      uploadResult = await cloudinary.uploader.upload(dataUri, {
        folder: `edusync/notes/${userId}`,
        public_id: `note_${noteId}_${Date.now()}`,
        resource_type: 'raw',
        overwrite: true,
        invalidate: true,
      });
    }

    logger.debug(`☁️  Uploaded note ${noteId} to Cloudinary: ${uploadResult.secure_url}`);

    return {
      cloudUrl: uploadResult.secure_url,
      cloudPublicId: uploadResult.public_id,
    };
  } catch (err) {
    logger.error(`☁️  Cloudinary upload failed for note ${noteId}: ${err.message}`);
    // Return null so caller falls back to MongoDB storage
    return null;
  }
};

// ─── Download ───────────────────────────────────────────────────────────────

/**
 * Download canvasData from a Cloudinary URL.
 *
 * @param {string} cloudUrl - The Cloudinary secure URL
 * @returns {Promise<string|null>} The canvasData string, or null on failure
 */
const downloadCanvasData = async (cloudUrl) => {
  if (!cloudUrl) return null;

  try {
    // Use dynamic import for node-fetch (ESM module)
    const response = await fetch(cloudUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();

    // If the content looks like JSON, return as-is
    // If base64, it's already been stored as image on Cloudinary
    return text;
  } catch (err) {
    logger.error(`☁️  Cloudinary download failed for ${cloudUrl}: ${err.message}`);
    return null;
  }
};

// ─── Delete ─────────────────────────────────────────────────────────────────

/**
 * Delete a file from Cloudinary by its public ID.
 *
 * @param {string} cloudPublicId - The Cloudinary public ID
 * @param {string} resourceType  - 'raw' for JSON, 'image' for base64 images
 */
const deleteFromCloud = async (cloudPublicId, resourceType = 'raw') => {
  if (!isConfigured || !cloudPublicId) return;

  try {
    await cloudinary.uploader.destroy(cloudPublicId, { resource_type: resourceType });
    logger.debug(`☁️  Deleted from Cloudinary: ${cloudPublicId}`);
  } catch (err) {
    // Non-critical: log but don't throw
    logger.warn(`☁️  Cloudinary delete failed for ${cloudPublicId}: ${err.message}`);
  }
};

// ─── Thumbnail Upload ────────────────────────────────────────────────────────

/**
 * Upload a base64 JPEG thumbnail (canvas snapshot) to Cloudinary.
 * Used for mobile read-only preview of canvas notes.
 *
 * @param {string} base64Image - data:image/jpeg;base64,... string
 * @param {string} userId      - Owner's user ID
 * @param {string} noteId      - Note/File ID
 * @returns {Promise<string|null>} The thumbnail URL or null on failure
 */
const uploadThumbnail = async (base64Image, userId, noteId) => {
  if (!isConfigured || !base64Image) return null;

  try {
    const uploadResult = await cloudinary.uploader.upload(base64Image, {
      folder: `edusync/thumbnails/${userId}`,
      public_id: `thumb_${noteId}`,
      resource_type: 'image',
      overwrite: true,
      invalidate: true,
      transformation: [{ width: 1200, crop: 'limit', quality: 80, format: 'jpg' }],
    });

    logger.debug(`☁️  Uploaded thumbnail for note ${noteId}: ${uploadResult.secure_url}`);
    return uploadResult.secure_url;
  } catch (err) {
    logger.warn(`☁️  Thumbnail upload failed for note ${noteId}: ${err.message}`);
    return null;
  }
};

const isCloudEnabled = () => isConfigured;

module.exports = {
  uploadCanvasData,
  uploadThumbnail,
  downloadCanvasData,
  deleteFromCloud,
  isCloudEnabled,
};
