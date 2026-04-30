'use strict';

const express = require('express');
const router = express.Router();

const {
  startSession, startSelfSession, joinSession, endSession, getSession,
  getMySessions, updateControls,
  setSessionMedia, getSessionMedia,
  saveSessionProgress,
  refreshQR,
  startSessionValidation, joinSessionValidation, setMediaValidation,

  updateControlsValidation, sessionIdParamValidation, sessionIdIdParamValidation,
  getActiveSessionsForClassroom, getActiveSessionsByDeskId, joinSessionDirect,
} = require('../controllers/sessionController');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { auditMiddleware } = require('../utils/activityLogger');

router.use(authenticate);

// POST /session/start — teacher starts a new class session
router.post(
  '/start',
  requireRole('teacher'),
  startSessionValidation,
  validate,
  auditMiddleware('session.start.api', 'session'),
  startSession
);

// POST /session/self-start — student starts a self-study session
router.post(
  '/self-start',
  requireRole(['student', 'teacher']),
  auditMiddleware('session.self_start.api', 'session'),
  startSelfSession
);

// POST /session/join — student joins via QR scan
router.post(
  '/join',
  requireRole('student'),
  joinSessionValidation,
  validate,
  auditMiddleware('session.join.api', 'session'),
  joinSession
);

// GET /session/active/:classroomId — discover active classes in a room
router.get('/active/:classroomId', getActiveSessionsForClassroom);

// GET /session/active/desk/:deskId — discover by teacher desk ID
router.get('/active/desk/:deskId', getActiveSessionsByDeskId);

// POST /session/join-direct — join directly without QR scan
router.post('/join-direct', requireRole('student'), joinSessionDirect);

// POST /session/join-teacher/:teacherId — join teacher's live class by teacher ID
router.post('/join-teacher/:teacherId', requireRole('student'), require('../controllers/sessionController').joinTeacherClass);

// POST /session/:sessionId/end — owner ends the class/study
router.post(
  '/:sessionId/end',
  requireRole(['teacher', 'student']),
  sessionIdParamValidation,
  validate,
  auditMiddleware('session.end.api', 'session'),
  endSession
);

// POST /session/save — manually save canvas progress
router.post(
  '/save',
  requireRole(['teacher', 'student']),
  saveSessionProgress
);



// PATCH /session/:sessionId/controls — teacher updates classroom controls
router.patch(
  '/:sessionId/controls',
  requireRole('teacher'),
  updateControlsValidation,
  validate,
  auditMiddleware('control.update.api', 'control'),
  updateControls
);

// POST /session/:sessionId/media — teacher sets YouTube/video URL for the session
router.post(
  '/:sessionId/media',
  requireRole('teacher'),
  sessionIdParamValidation,
  setMediaValidation,
  validate,
  auditMiddleware('session.media.set', 'session'),
  setSessionMedia
);

// GET  /session/:sessionId/media — get current media state (any authenticated user)
router.get('/:sessionId/media', sessionIdParamValidation, validate, getSessionMedia);

// POST /session/:sessionId/refresh-qr — teacher refreshes QR
router.post('/:sessionId/refresh-qr', requireRole('teacher'), sessionIdParamValidation, validate, refreshQR);

// GET  /session/:sessionId/notes — get notes for a specific session
router.get('/:sessionId/notes', sessionIdParamValidation, validate, require('../controllers/fileController').getUserNotes);

// GET  /session/mine — user's own session history
router.get('/mine', getMySessions);

// GET  /session/:id — get session details (participants + controls)
router.get('/:id', sessionIdIdParamValidation, validate, getSession);

module.exports = router;
