'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 50 * 1024 * 1024; // 50MB

// Ensure upload dirs exist (with error handling for read-only filesystems)
let useFileUploads = true;
['uploads/files', 'uploads/temp', 'exports/pdfs'].forEach((dir) => {
  const p = path.join(process.cwd(), dir);
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (err) {
    // Fall back to memory-only uploads if directory creation fails
    useFileUploads = false;
  }
});

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!useFileUploads) {
      return cb(new Error('File storage not available'));
    }
    const dest = path.join(process.cwd(), UPLOAD_DIR, 'files');
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'text/plain',
]);

// Dangerous file extensions to block
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.jar', '.app',
  '.deb', '.rpm', '.dmg', '.pkg', '.msi', '.scr', '.pif', '.com',
  '.dll', '.so', '.dylib', '.lib', '.bin', '.out',
]);

const fileFilter = (req, file, cb) => {
  // Check MIME type
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `File type ${file.mimetype} not allowed`));
  }
  
  // Check for dangerous file extensions
  const ext = path.extname(file.originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `File extension ${ext} is not allowed for security reasons`));
  }
  
  // Check for double extensions (e.g., file.jpg.exe)
  const parts = file.originalname.split('.');
  if (parts.length > 2) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Files with multiple extensions are not allowed'));
  }
  
  cb(null, true);
};

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: MAX_FILE_SIZE, files: 5 },
  fileFilter,
});

// Memory storage for quick processing (e.g. canvas snapshots)
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB for in-memory
  fileFilter,
});

module.exports = { upload, memoryUpload };
