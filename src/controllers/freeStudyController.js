'use strict';

/**
 * ─── FREE STUDY MODE ─────────────────────────────────────────────────────────
 *
 * Feature: Jab class mein teacher nahi hai, students apni desk screens pe
 * freely kaam kar sakte hain — canvas, notes, YouTube, AI (ChatGPT) sab enabled.
 *
 * Flow:
 *  1. Student app checks classroom status → GET /classroom/:id/status
 *  2. If no active teacher session → "free_study" mode available
 *  3. Student calls POST /session/free-study/start
 *  4. A "free_study" session starts with ALL controls enabled
 *  5. If teacher later starts a class → student gets notified via socket
 *     and the free study session ends automatically.
 *
 * API Endpoints:
 *  GET    /classroom/:classroomId/status       → check if teacher is active
 *  POST   /session/free-study/start            → start free study
 *  POST   /session/free-study/:sessionId/end   → end free study
 *  GET    /session/free-study/active           → get my active free study session
 */

const { v4: uuidv4 } = require('uuid');
const Session = require('../models/Session');
const SessionParticipant = require('../models/SessionParticipant');
const Classroom = require('../models/Classroom');
const AppControls = require('../models/AppControls');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');
const { cache } = require('../config/redis');
const { getSocketServer } = require('../socket/server');
const logger = require('../utils/logger');

// ─── All controls enabled by default in Free Study Mode ──────────────────────
const FREE_STUDY_CONTROLS = {
  keyboardEnabled: true,
  copyPasteEnabled: true,
  aiEnabled: true,
  youtubeEnabled: true,
};

// ─── GET /classroom/:classroomId/status ──────────────────────────────────────
/**
 * Returns classroom status: whether teacher is currently active.
 * Students use this to decide whether to enter Free Study mode.
 *
 * Response includes:
 *  - teacherActive: boolean
 *  - activeSessionId: string | null   (teacher's session to join via QR)
 *  - freeStudyAllowed: boolean
 */
const getClassroomStatus = asyncHandler(async (req, res) => {
  const { classroomId } = req.params;

  // Try Redis cache first (avoids DB hit on every desk screen poll)
  const cacheKey = `classroom_status:${classroomId}`;
  const cached = await cache.getJSON(cacheKey);
  if (cached) return sendSuccess(res, cached, 'Classroom status (cached)');

  // Find classroom
  const classroom = await Classroom.findOne({
    $or: [{ _id: classroomId }, { code: classroomId.toUpperCase() }],
    isActive: true,
  }).lean();
  if (!classroom) return sendError(res, 'Classroom not found', 404);

  // Check if student is enrolled
  const isEnrolled = classroom.students.some(
    (s) => s.userId.toString() === req.user._id.toString() && s.isActive
  );
  const isTeacher = classroom.teacherId.toString() === req.user._id.toString();
  if (!isEnrolled && !isTeacher) return sendError(res, 'You are not part of this classroom', 403);

  // Check for active teacher session in this classroom
  const activeTeacherSession = await Session.findOne({
    classroomId: classroom._id,
    teacherId: classroom.teacherId,
    status: 'active',
    sessionType: 'class',
  })
    .select('sessionId roomId title startedAt participantCount')
    .lean();

  const payload = {
    classroomId: classroom._id,
    classroomName: classroom.name,
    classroomCode: classroom.code,
    teacherActive: !!activeTeacherSession,
    activeTeacherSession: activeTeacherSession
      ? {
          sessionId: activeTeacherSession.sessionId,
          roomId: activeTeacherSession.roomId,
          title: activeTeacherSession.title,
          startedAt: activeTeacherSession.startedAt,
          participantCount: activeTeacherSession.participantCount,
        }
      : null,
    // Free study allowed ONLY when no teacher is actively conducting class
    freeStudyAllowed: !activeTeacherSession,
    message: activeTeacherSession
      ? 'Teacher is conducting a class. Scan the QR code to join.'
      : 'No active class. Free Study Mode is available.',
  };

  // Cache for 15 seconds — desk screens poll frequently, don't hammer DB
  await cache.setJSON(cacheKey, payload, 15);

  return sendSuccess(res, payload, 'Classroom status');
});

// ─── POST /session/free-study/start ──────────────────────────────────────────
/**
 * Student starts a Free Study session.
 * - Linked to their classroom (optional, via classroomId in body)
 * - ALL controls enabled by default
 * - Only ONE free study session per student at a time
 *
 * Body: { classroomId?, subject?, title? }
 */
const startFreeStudy = asyncHandler(async (req, res) => {
  const { classroomId, subject, title } = req.body;
  const student = req.user;

  // 1. Check if student already has an active session of any kind
  const existingSession = await Session.findOne({
    ownerId: student._id,
    status: 'active',
  });
  if (existingSession) {
    return sendError(
      res,
      `You already have an active ${existingSession.sessionType === 'class' ? 'class' : existingSession.sessionType === 'free_study' ? 'Free Study' : 'self-study'} session. End it first.`,
      409
    );
  }

  // 2. If classroomId provided — verify enrollment & check teacher not active
  let classroom = null;
  if (classroomId) {
    classroom = await Classroom.findOne({
      $or: [{ _id: classroomId }, { code: classroomId.toUpperCase() }],
      isActive: true,
    }).lean();
    if (!classroom) return sendError(res, 'Classroom not found', 404);

    const isEnrolled = classroom.students.some(
      (s) => s.userId.toString() === student._id.toString() && s.isActive
    );
    if (!isEnrolled) return sendError(res, 'You are not enrolled in this classroom', 403);

    // Safety: don't allow free study if teacher just started class
    const teacherActive = await Session.exists({
      classroomId: classroom._id,
      teacherId: classroom.teacherId,
      status: 'active',
      sessionType: 'class',
    });
    if (teacherActive) {
      return sendError(
        res,
        'Teacher has started a class. Please join the class instead.',
        409
      );
    }
  }

  // 3. Create Free Study Session
  const sessionId = uuidv4();
  const roomId = `free_${uuidv4()}`;

  const session = await Session.create({
    sessionId,
    roomId,
    ownerId: student._id,
    teacherId: null, // No teacher in free study
    classroomId: classroom?._id || null,
    sessionType: 'free_study',
    title: title || (classroom ? `Free Study — ${classroom.name}` : `Free Study — ${subject || 'General'}`),
    subject: subject || classroom?.subject || 'General',
    status: 'active',
    qrToken: uuidv4(), // Not used for joining, just required by schema
    startedAt: new Date(),
    // ALL controls enabled — student has full freedom
    appControls: FREE_STUDY_CONTROLS,
    layoutConfig: {
      studentWritingRatio: 1.0,  // Full screen for student
      teacherPreviewRatio: 0.0,
      mode: 'standard',
    },
  });

  // 4. Create AppControls document (all enabled)
  await AppControls.create({
    sessionId: session._id,
    teacherId: null,
    ...FREE_STUDY_CONTROLS,
  });

  // 5. Add student as participant
  await SessionParticipant.create({
    sessionId: session._id,
    userId: student._id,
    role: 'student',
    joinedAt: new Date(),
    isConnected: true,
  });

  // 6. Cache for quick lookup
  await cache.setJSON(
    `session:${sessionId}`,
    {
      _id: session._id.toString(),
      sessionId,
      roomId,
      ownerId: student._id.toString(),
      sessionType: 'free_study',
      status: 'active',
      controls: FREE_STUDY_CONTROLS,
    },
    86400
  );

  // 7. Invalidate classroom status cache so next poll shows updated state
  if (classroom) {
    await cache.del(`classroom_status:${classroom._id.toString()}`);
    await cache.del(`classroom_status:${classroom.code}`);
  }

  logActivity({
    sessionId: session._id,
    userId: student._id,
    actorRole: 'student',
    action: 'free_study.start',
    category: 'session',
    details: {
      classroomId: classroom?._id || null,
      subject: session.subject,
      title: session.title,
    },
  });

  logger.info(`[FreeStudy] Started for student ${student.name} (${student._id}) | Session: ${sessionId}`);

  return sendSuccess(
    res,
    {
      sessionId,
      roomId,
      sessionType: 'free_study',
      title: session.title,
      subject: session.subject,
      controls: FREE_STUDY_CONTROLS,
      layoutConfig: session.layoutConfig,
      startedAt: session.startedAt,
      message: 'Free Study Mode active. All tools enabled.',
    },
    'Free Study session started',
    201
  );
});

// ─── POST /session/free-study/:sessionId/end ─────────────────────────────────
/**
 * Student ends their free study session (triggers save pipeline).
 */
const endFreeStudy = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const student = req.user;

  const session = await Session.findOne({
    sessionId,
    ownerId: student._id,
    sessionType: 'free_study',
    status: 'active',
  });
  if (!session) return sendError(res, 'Free Study session not found or already ended', 404);

  // End the session
  session.status = 'ended';
  session.endedAt = new Date();
  await session.save();

  // Disconnect participants
  await SessionParticipant.updateMany(
    { sessionId: session._id, isConnected: true },
    { isConnected: false, leftAt: new Date() }
  );

  // Invalidate cache
  await cache.del(`session:${sessionId}`);

  // Disconnect socket room
  const io = getSocketServer();
  if (io) {
    io.to(session.roomId).emit('session:ended', {
      message: 'Free Study session ended. Saving your notes...',
      sessionId,
    });
  }

  // Trigger save pipeline (PDF + notifications)
  const { triggerSavePipeline } = require('../services/savePipeline');
  triggerSavePipeline(session._id.toString()).catch((err) =>
    logger.error(`[FreeStudy] Save pipeline failed for ${session._id}: ${err.message}`)
  );

  logActivity({
    sessionId: session._id,
    userId: student._id,
    actorRole: 'student',
    action: 'free_study.end',
    category: 'session',
    details: { duration: Math.floor((new Date() - session.startedAt) / 60000) + 'min' },
  });

  return sendSuccess(res, {
    sessionId,
    endedAt: session.endedAt,
    status: 'ended',
  }, 'Free Study session ended. Notes are being saved.');
});

// ─── GET /session/free-study/active ──────────────────────────────────────────
/**
 * Returns the student's currently active free study session (if any).
 * Used by desk screen on startup to resume a session.
 */
const getActiveFreeStudy = asyncHandler(async (req, res) => {
  const session = await Session.findOne({
    ownerId: req.user._id,
    sessionType: 'free_study',
    status: 'active',
  })
    .select('sessionId roomId title subject appControls layoutConfig startedAt')
    .lean();

  if (!session) return sendSuccess(res, { session: null }, 'No active Free Study session');

  return sendSuccess(res, {
    session: {
      ...session,
      controls: session.appControls,
    },
  }, 'Active Free Study session found');
});

// ─── Socket helper: Notify free study students when teacher starts class ──────
/**
 * Called by sessionController.startSession() after teacher starts class.
 * Emits 'teacher:classStarted' to all students in the classroom who are
 * in Free Study mode — they should end their free study and join the class.
 */
const notifyFreeStudyStudents = async (classroomId, teacherSession) => {
  try {
    const io = getSocketServer();
    if (!io) return;

    // Find all active free study sessions in this classroom
    const freeStudySessions = await Session.find({
      classroomId,
      sessionType: 'free_study',
      status: 'active',
    })
      .select('roomId ownerId sessionId')
      .lean();

    for (const fs of freeStudySessions) {
      // Notify student their free study is interrupted
      io.to(fs.roomId).emit('teacher:classStarted', {
        message: 'Your teacher has started a class! Join now.',
        teacherSession: {
          sessionId: teacherSession.sessionId,
          title: teacherSession.title,
          roomId: teacherSession.roomId,
        },
        action: 'redirect_to_class', // Frontend should show QR scan prompt
      });

      // Auto-end the free study session gracefully
      await Session.findByIdAndUpdate(
        (await Session.findOne({ sessionId: fs.sessionId }))._id,
        { status: 'ended', endedAt: new Date() }
      );

      logger.info(`[FreeStudy] Auto-ended for student ${fs.ownerId} — teacher started class`);
    }

    // Invalidate classroom status cache
    await cache.del(`classroom_status:${classroomId.toString()}`);
  } catch (err) {
    logger.error(`[FreeStudy] notifyFreeStudyStudents error: ${err.message}`);
  }
};

module.exports = {
  getClassroomStatus,
  startFreeStudy,
  endFreeStudy,
  getActiveFreeStudy,
  notifyFreeStudyStudents,
};
