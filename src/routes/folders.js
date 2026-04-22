'use strict';

const express = require('express');
const router = express.Router();

const {
  createFolder,
  getFolders,
  getFolderContents,
  updateFolder,
  deleteFolder,
  moveFileToFolder,
  createFolderValidation,
  updateFolderValidation,
  moveFileValidation,
} = require('../controllers/folderController');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');

router.use(authenticate);
router.use(apiLimiter);

// POST   /folders               — Create a new subject-wise folder
router.post('/', createFolderValidation, validate, createFolder);

// GET    /folders               — List all folders (filter by ?subject= or ?parentFolder=)
router.get('/', getFolders);

// GET    /folders/:folderId     — Get folder details + file contents inside it
router.get('/:folderId', getFolderContents);

// PUT    /folders/:folderId     — Rename / update folder (color, subject, type)
router.put('/:folderId', updateFolderValidation, validate, updateFolder);

// DELETE /folders/:folderId     — Soft-delete folder + cascade its files
router.delete('/:folderId', deleteFolder);

// PATCH  /folders/:folderId/files/:fileId — Move a file into a folder
//        Use folderId='none' to remove file from any folder
router.patch('/:folderId/files/:fileId', moveFileValidation, validate, moveFileToFolder);

module.exports = router;
