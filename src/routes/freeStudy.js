'use strict';

/**
 * ─── FREE STUDY MODE ROUTES ──────────────────────────────────────────────────
 *
 * GET  /classroom/:classroomId/status      → Check if teacher is active in class
 * POST /session/free-study/start           → Student starts free study session
 * POST /session/free-study/:sessionId/end  → Student ends free study session
 * GET  /session/free-study/active          → Get student's active free study session
 */

const express = require('express');
const router = express.Router();

const {
  getClassroomStatus,
  startFreeStudy,
  endFreeStudy,
  getActiveFreeStudy,
} = require('../controllers/freeStudyController');

const { authenticate, requireRole } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');

router.use(authenticate);
router.use(apiLimiter);

// ─── Classroom Status (students poll this — heavily cached) ─────────────────
// GET /classroom/:classroomId/status
// Used by desk screen to decide: join class (teacher active) OR free study
router.get(
  '/classroom/:classroomId/status',
  requireRole(['student', 'teacher']),
  getClassroomStatus
);

// ─── Free Study Session Management ──────────────────────────────────────────

// GET /session/free-study/active — resume existing session on page reload
router.get(
  '/session/free-study/active',
  requireRole('student'),
  getActiveFreeStudy
);

// POST /session/free-study/start — student starts free study
router.post(
  '/session/free-study/start',
  requireRole('student'),
  [
    body('classroomId').optional().isString().trim(),
    body('subject').optional().isString().isLength({ max: 100 }).trim(),
    body('title').optional().isString().isLength({ max: 200 }).trim(),
  ],
  validate,
  startFreeStudy
);

// POST /session/free-study/:sessionId/end — student ends free study
router.post(
  '/session/free-study/:sessionId/end',
  requireRole('student'),
  endFreeStudy
);

module.exports = router;
