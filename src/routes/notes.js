'use strict';

const express = require('express');
const router = express.Router();
const {
  getUserNotes,
  saveNote,
  getNotesBySubject,
  deleteNote,
  syncNotesByGmail
} = require('../controllers/fileController');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');

router.use(authenticate);
router.use(apiLimiter);

// Existing mobile notes API
router.get('/', getUserNotes);

// --- New Missing Endpoints Mapped from Student App ---
router.post('/save', saveNote);
router.get('/subject/:subjectId', getNotesBySubject);
router.delete('/:noteId', deleteNote);

// --- Gmail Sync Endpoint (Cross-Platform) ---
router.get('/sync/:gmail', syncNotesByGmail);

module.exports = router;
