'use strict';

const express = require('express');
const router = express.Router();

const {
  uploadFile, getFile, getUserNotes, deleteFile,
  saveStrokeBatch, getPageStrokes,
  createPage, getSessionPages, saveSnapshot,
} = require('../controllers/fileController');
const { authenticate } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');
const { body } = require('express-validator');

router.use(authenticate);

// GET /user/notes — mobile notes API
router.get('/notes', getUserNotes);

// File CRUD
router.post('/upload', uploadLimiter, upload.single('file'), uploadFile);
router.get('/:id', getFile);
router.delete('/:id', deleteFile);

// Stroke batches (batch write, never per-stroke)
router.post('/strokes/batch', [
  body('sessionId').notEmpty(),
  body('pageId').notEmpty(),
  body('strokes').isArray({ min: 1 }),
], validate, saveStrokeBatch);

router.get('/strokes/page/:pageId', getPageStrokes);

// Pages
router.post('/pages', [
  body('sessionId').notEmpty(),
  body('pageNumber').isInt({ min: 1 }),
], validate, createPage);

router.get('/pages/session/:sessionId', getSessionPages);

// Canvas snapshot (for PDF generation)
router.post('/pages/snapshot', [
  body('pageId').notEmpty(),
  body('snapshotDataUrl').notEmpty(),
], validate, saveSnapshot);

module.exports = router;
