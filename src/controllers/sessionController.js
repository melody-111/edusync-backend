'use strict';

const { body, param } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const Session = require('../models/Session');
const SessionParticipant = require('../models/SessionParticipant');
const Device = require('../models/Device');
const AppControls = require('../models/AppControls');
const MediaSession = require('../models/MediaSession');
const { generateSessionQR, validateQRPayload } = require('../utils/qr');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');
const { cache } = require('../config/redis');
const { triggerSavePipeline } = require('../services/savePipeline');
const { addPdfJob } = require('../queues/pdfQueue');
const { getSocketServer } = require('../socket/server');
const logger = require('../utils/logger');


// ─── Start Session ──────────────────────────────────────────────────────────
const startSession = asyncHandler(async (req, res) => {
  const { title, description, classroomId, folderId, fileId, branch, year, semester } = req.body;
  const teacher = req.user;


  // Check if teacher has an active session already
  const existing = await Session.findOne({ teacherId: teacher._id, status: 'active' });
  if (existing) {
    return sendError(res, 'You already have an active session. End it before starting a new one.', 409);
  }

  const sessionId = uuidv4();
  const roomId = `room_${uuidv4()}`;
  const { qrToken, qrCodeDataUrl, qrPayload } = await generateSessionQR(sessionId);


  let initialCanvasData = null;
  if (fileId) {
    const File = require('../models/File');
    const existingFile = await File.findOne({ _id: fileId, ownerId: teacher._id });
    if (existingFile) {
      initialCanvasData = existingFile.canvasData;
    }
  }

  const session = await Session.create({
    sessionId,
    roomId,
    teacherId: teacher._id,
    ownerId: teacher._id,
    sessionType: 'class',
    title: title || (fileId ? 'Editing Session' : 'Untitled Session'),
    description: description || '',
    classroomId: classroomId || null,
    branch: branch || null,
    year: year || null,
    semester: semester || null,
    folderId: folderId || null,
    fileId: fileId || null,
    status: 'active',
    qrToken,
    qrCodeDataUrl,
    startedAt: new Date(),
    appControls: {
      keyboardEnabled: false,
      copyPasteEnabled: false,
      aiEnabled: false,
      youtubeEnabled: true,
    },
  });


  // Create AppControls document
  await AppControls.create({
    sessionId: session._id,
    teacherId: teacher._id,
    keyboardEnabled: false,
    copyPasteEnabled: false,
    aiEnabled: false,
    youtubeEnabled: true,
  });

  // Add teacher as participant
  await SessionParticipant.create({
    sessionId: session._id,
    userId: teacher._id,
    role: 'teacher',
    joinedAt: new Date(),
    isConnected: true,
  });

  // Cache session data for fast lookup
  await cache.setJSON(`session:${sessionId}`, {
    _id: session._id.toString(),
    sessionId,
    roomId,
    teacherId: teacher._id.toString(),
    ownerId: teacher._id.toString(),
    sessionType: 'class',
    status: 'active',
    qrToken,
  }, 86400); // 24h

  logActivity({
    sessionId: session._id,
    userId: teacher._id,
    actorRole: 'teacher',
    action: 'session.start',
    category: 'session',
    details: { title: session.title, roomId },
  });

  // Notify connected students in the specific classroom that a class has started
  const io = getSocketServer();
  if (io) {
    // Determine the target broadcast room
    let targetRoom = null;
    if (session.classroomId) {
      targetRoom = `classroom:${session.classroomId}`;
    } else if (session.branch || session.year || session.semester) {
      // University composite room naming: "edu:BRANCH:YEAR:SEM"
      targetRoom = `edu:${session.branch || 'any'}:${session.year || 'any'}:${session.semester || 'any'}`;
    }

    const broadcastData = {
      sessionId,
      roomId,
      teacherName: teacher.name,
      teacherDeskId: teacher.deskId,
      title: session.title,
      branch: session.branch,
      year: session.year,
      semester: session.semester
    };

    if (targetRoom) {
      io.to(targetRoom).emit('class:started', broadcastData);
      logger.info(`Class start broadcasted to ${targetRoom}`);
    } else {
      io.emit('class:started', broadcastData);
    }
  }

  return sendSuccess(res, {
    sessionId,
    roomId,
    qrCodeDataUrl,
    qrPayload,
    session: {
      _id: session._id,
      title: session.title,
      status: session.status,
      startedAt: session.startedAt,
      appControls: session.appControls,
      layoutConfig: session.layoutConfig,
      initialCanvasData,
    },
  }, 'Session started', 201);
});


/**
 * ─── Start Self-Study Session ────────────────────────────────────────────────
 * Allows a student to start their own session for individual study/assignment.
 */
const startSelfSession = asyncHandler(async (req, res) => {
  const { title, subject } = req.body;
  const user = req.user;

  // Check if user has an active session
  const existing = await Session.findOne({ ownerId: user._id, status: 'active' });
  if (existing) {
    return sendError(res, 'You already have an active session.', 409);
  }

  const sessionId = uuidv4();
  const roomId = `self_${uuidv4()}`;
  const { qrToken, qrCodeDataUrl } = await generateSessionQR(sessionId);


  const session = await Session.create({
    sessionId,
    roomId,
    ownerId: user._id,
    sessionType: 'self',
    title: title || `Self Study - ${subject || 'General'}`,
    subject: subject || 'General',
    status: 'active',
    qrToken,
    qrCodeDataUrl,
    startedAt: new Date(),
    // Self study: keyboard/AI enabled by default for the student
    appControls: {
      keyboardEnabled: true,
      copyPasteEnabled: true,
      aiEnabled: true,
      youtubeEnabled: true,
    },
    // 100% writing area for self-study
    layoutConfig: {
      studentWritingRatio: 1.0,
      teacherPreviewRatio: 0.0,
      mode: 'standard',
    },
  });

  await SessionParticipant.create({
    sessionId: session._id,
    userId: user._id,
    role: user.role, // keeping original role but they are the owner
    joinedAt: new Date(),
    isConnected: true,
  });

  await cache.setJSON(`session:${sessionId}`, {
    _id: session._id.toString(),
    sessionId,
    roomId,
    ownerId: user._id.toString(),
    sessionType: 'self',
    status: 'active',
    qrToken,
  }, 86400);

  logActivity({
    sessionId: session._id,
    userId: user._id,
    actorRole: user.role,
    action: 'session.self_start',
    category: 'session',
    details: { subject: session.subject },
  });

  return sendSuccess(res, {
    sessionId,
    roomId,
    qrCodeDataUrl,
    session,
  }, 'Self-study session started', 201);
});


/**
 * GET /session/active/:classroomId
 * Discovery endpoint for students to find active classes in their room.
 */
const getActiveSessionsForClassroom = asyncHandler(async (req, res) => {
  const { classroomId } = req.params;
  
  const sessions = await Session.find({ 
    classroomId, 
    status: 'active' 
  })
  .populate('teacherId', 'name avatar deskId')
  .sort({ startedAt: -1 })
  .lean();

  return sendSuccess(res, { sessions }, 'Active sessions retrieved');
});

/**
 * POST /session/join-direct
 * Allows joining a session directly via ID (for terminal/desk mode)
 */
const joinSessionDirect = asyncHandler(async (req, res) => {
  const { sessionId } = req.body;
  const student = req.user;

  const session = await Session.findOne({ sessionId, status: 'active' });
  if (!session) return sendError(res, 'Session not found or inactive', 404);

  // Upsert participant
  await SessionParticipant.findOneAndUpdate(
    { sessionId: session._id, userId: student._id },
    {
      role: 'student',
      joinedAt: new Date(),
      isConnected: true,
      leftAt: null,
    },
    { upsert: true, new: true }
  );

  // Update participant count
  await Session.findByIdAndUpdate(session._id, { $inc: { participantCount: 1 } });

  // Cache participant → session lookup
  await cache.setJSON(`participant:${student._id}:session`, {
    sessionId: session._id.toString(),
    roomId: session.roomId,
  }, 86400);

  const [controls, media] = await Promise.all([
    AppControls.findOne({ sessionId: session._id }).lean(),
    MediaSession.findOne({ sessionId: session._id, isActive: true }).lean(),
  ]);

  return sendSuccess(res, {
    roomId: session.roomId,
    sessionId: session.sessionId,
    sessionTitle: session.title,
    controls: controls || session.appControls,
    media: media || null,
    layoutConfig: session.layoutConfig,
  }, 'Joined session via direct ID');
});


/**
 * GET /session/active/desk/:deskId
 * Discovery endpoint to find active sessions by teacher's Desk ID.
 */
const getActiveSessionsByDeskId = asyncHandler(async (req, res) => {
  const { deskId } = req.params;
  
  const teacher = await require('../models/User').findOne({ deskId, role: 'teacher' });
  if (!teacher) return sendError(res, 'Teacher not found', 404);

  const sessions = await Session.find({ 
    teacherId: teacher._id, 
    status: 'active' 
  })
  .populate('teacherId', 'name avatar deskId')
  .sort({ startedAt: -1 })
  .lean();

  return sendSuccess(res, { sessions }, 'Active sessions retrieved for Desk ID');
});


// ─── Join Session (Student scans QR) ──────────────────────────────────────────
const joinSession = asyncHandler(async (req, res) => {
  const { qrData, deviceId } = req.body;
  const student = req.user;

  let parsed;
  try {
    parsed = typeof qrData === 'string' ? JSON.parse(qrData) : qrData;
  } catch {
    return sendError(res, 'Invalid QR data', 400);
  }

  const { sessionId, token, sig } = parsed;
  if (!sessionId || !token || !sig) return sendError(res, 'Malformed QR payload', 400);

  // Look up session — must select qrToken explicitly (select:false in schema)
  const session = await Session.findOne({ sessionId }).select('+qrToken');
  if (!session) return sendError(res, 'Session not found', 404);
  if (session.status !== 'active') return sendError(res, 'Session is not active', 403);

  // Validate QR (timing-safe comparison + signature)
  const isValid = validateQRPayload(parsed, session.qrToken, sessionId);
  if (!isValid) return sendError(res, 'Invalid or expired QR code', 403);

  // Bind device if provided
  let device = null;
  if (deviceId) {
    device = await Device.findOneAndUpdate(
      { deviceId, userId: student._id },
      { activeSessionId: session._id, status: 'online' },
      { new: true, upsert: false }
    );
  }

  // Upsert participant
  await SessionParticipant.findOneAndUpdate(
    { sessionId: session._id, userId: student._id },
    {
      role: 'student',
      deviceId: device?._id || null,
      joinedAt: new Date(),
      isConnected: true,
      leftAt: null,
    },
    { upsert: true, new: true }
  );

  // Update participant count
  await Session.findByIdAndUpdate(session._id, { $inc: { participantCount: 1 } });

  // Cache participant → session lookup
  await cache.setJSON(`participant:${student._id}:session`, {
    sessionId: session._id.toString(),
    roomId: session.roomId,
  }, 86400);

  // Get current controls and media for joined student
  const [controls, media] = await Promise.all([
    AppControls.findOne({ sessionId: session._id }).lean(),
    MediaSession.findOne({ sessionId: session._id, isActive: true }).lean(),
  ]);

  logActivity({
    sessionId: session._id,
    userId: student._id,
    actorRole: 'student',
    action: 'student.join',
    category: 'session',
  });

  return sendSuccess(res, {
    roomId: session.roomId,
    sessionId: session.sessionId,
    sessionTitle: session.title,
    controls: controls
      ? {
          keyboardEnabled: controls.keyboardEnabled,
          copyPasteEnabled: controls.copyPasteEnabled,
          aiEnabled: controls.aiEnabled,
          youtubeEnabled: controls.youtubeEnabled,
        }
      : session.appControls,
    media: media ? {
      mediaUrl: media.mediaUrl,
      mediaType: media.mediaType,
      youtubeVideoId: media.youtubeVideoId,
      state: media.state,
      seekTo: media.seekPositionSeconds,
    } : null,
    layoutConfig: session.layoutConfig,
  }, 'Joined session successfully');
});

// ─── End Session ───────────────────────────────────────────────────────────────
const endSession = asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId || req.body.sessionId;
  const { canvasData } = req.body;
  const user = req.user;




  const session = await Session.findOne({ sessionId, ownerId: user._id });
  if (!session) return sendError(res, 'Session not found or not yours', 404);

  if (session.status !== 'active') return sendError(res, 'Session is already ended', 400);

  // 1. Lock session
  session.status = 'ended';
  session.endedAt = new Date();
  session.qrToken = crypto.randomBytes(16).toString('hex'); // Invalidate QR by replacing token
  await session.save();

  // 2. Invalidate cache
  await cache.del(`session:${sessionId}`);

  // 3. Disconnect all devices bound to this session
  await Device.updateMany(
    { activeSessionId: session._id },
    { activeSessionId: null, status: 'offline' }
  );

  // 4. Mark all participants as disconnected
  await SessionParticipant.updateMany(
    { sessionId: session._id, isConnected: true },
    { isConnected: false, leftAt: new Date() }
  );

  // 5. Close Socket.io room and disconnect all clients
  const io = getSocketServer();
  if (io) {
    io.to(session.roomId).emit('session:ended', {
      message: 'Class has ended. Your notes are being saved.',
      sessionId,
    });
    // Give clients 2s to receive the event, then force-disconnect
    setTimeout(() => {
      const room = io.sockets.adapter.rooms.get(session.roomId);
      if (room) {
        room.forEach((socketId) => {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) socket.disconnect(true);
        });
      }
    }, 2000);
  }

  // 6. Trigger async save pipeline (notes, PDF generation)
  triggerSavePipeline(session._id.toString()).catch((err) =>
    logger.error(`Save pipeline failed for session ${session._id}: ${err.message}`)
  );

  // 7. Save Canvas Persistence (New: Reopenable notes)
  if (canvasData) {
    const File = require('../models/File');
    if (session.fileId) {
      // Reopening/Editing: update existing file
      await File.findByIdAndUpdate(session.fileId, { canvasData, lastAutoSavedAt: new Date() });
    } else {
      // New Class: save to linked folder (or default)
      await File.create({
        ownerId: user._id,
        ownerRole: user.role,
        fileType: 'note',
        title: session.title || `Class Notes - ${new Date().toISOString().split('T')[0]}`,
        folderId: session.folderId || null,
        canvasData,
        sessionId: session._id,
      });
    }
  }

  // Trigger background PDF generation
  if (canvasData) {
    addPdfJob({ 
      sessionId: session._id, 
      canvasData, 
      ownerId: user._id, 
      title: session.title 
    }).catch(err => logger.error(`Failed to enqueue background PDF: ${err}`));
  }



  logActivity({
    sessionId: session._id,
    userId: user._id,
    actorRole: user.role,
    action: 'session.end',
    category: 'session',
  });


  return sendSuccess(res, {
    sessionId,
    endedAt: session.endedAt,
    status: session.status,
  }, 'Session ended. Save pipeline triggered.');
});

// ─── Get Session Details ───────────────────────────────────────────────────────
const getSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = req.user;

  // Safe query: only attempt _id match if it's a valid MongoDB ObjectId
  const mongoose = require('mongoose');
  const isObjectId = mongoose.Types.ObjectId.isValid(id);
  const session = await Session.findOne(
    isObjectId ? { $or: [{ _id: id }, { sessionId: id }] } : { sessionId: id }
  ).lean();

  if (!session) return sendError(res, 'Session not found', 404);

  // Verify user has access
  const isTeacher = session.teacherId?.toString() === user._id.toString();
  if (!isTeacher) {
    const participant = await SessionParticipant.findOne({
      sessionId: session._id,
      userId: user._id,
    });
    if (!participant) return sendError(res, 'Access denied', 403);
  }

  const participants = await SessionParticipant.find({ sessionId: session._id })
    .populate('userId', 'name email avatar role')
    .lean();

  return sendSuccess(res, { session, participants });
});

// ─── Get Teacher's Sessions ────────────────────────────────────────────────────
const getMySessions = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const user = req.user;

  const query = { teacherId: user._id };
  if (status) query.status = status;

  const sessions = await Session.find(query)
    .sort({ startedAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit, 10))
    .lean();

  const total = await Session.countDocuments(query);

  return sendSuccess(res, {
    sessions,
    pagination: { total, page: parseInt(page, 10), limit: parseInt(limit, 10), totalPages: Math.ceil(total / limit) },
  });
});

// ─── Update Controls (Teacher only) ─────────────────────────────────────────
const updateControls = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const teacher = req.user;
  const { keyboardEnabled, copyPasteEnabled, aiEnabled, youtubeEnabled } = req.body;

  const session = await Session.findOne({ sessionId, teacherId: teacher._id, status: 'active' });
  if (!session) return sendError(res, 'Active session not found', 404);

  const controls = await AppControls.findOne({ sessionId: session._id });
  if (!controls) return sendError(res, 'Controls not found', 404);

  const oldValues = {
    keyboardEnabled: controls.keyboardEnabled,
    copyPasteEnabled: controls.copyPasteEnabled,
    aiEnabled: controls.aiEnabled,
    youtubeEnabled: controls.youtubeEnabled,
  };

  // Apply updates
  if (keyboardEnabled !== undefined) controls.keyboardEnabled = keyboardEnabled;
  if (copyPasteEnabled !== undefined) controls.copyPasteEnabled = copyPasteEnabled;
  if (aiEnabled !== undefined) controls.aiEnabled = aiEnabled;
  if (youtubeEnabled !== undefined) controls.youtubeEnabled = youtubeEnabled;
  controls.updatedBy = teacher._id;

  // Append to changelog
  Object.entries({ keyboardEnabled, copyPasteEnabled, aiEnabled, youtubeEnabled }).forEach(([field, val]) => {
    if (val !== undefined && oldValues[field] !== val) {
      controls.changeLog.push({ changedBy: teacher._id, field, oldValue: oldValues[field], newValue: val, changedAt: new Date() });
    }
  });

  await controls.save();

  // Also update session snapshot
  await Session.findByIdAndUpdate(session._id, { appControls: {
    keyboardEnabled: controls.keyboardEnabled,
    copyPasteEnabled: controls.copyPasteEnabled,
    aiEnabled: controls.aiEnabled,
    youtubeEnabled: controls.youtubeEnabled,
  }});

  // Broadcast control update to room
  const io = getSocketServer();
  if (io) {
    io.to(session.roomId).emit('controlUpdate', {
      keyboardEnabled: controls.keyboardEnabled,
      copyPasteEnabled: controls.copyPasteEnabled,
      aiEnabled: controls.aiEnabled,
      youtubeEnabled: controls.youtubeEnabled,
    });
  }

  logActivity({
    sessionId: session._id,
    userId: teacher._id,
    actorRole: 'teacher',
    action: 'control.update',
    category: 'control',
    details: { changes: req.body },
  });

  return sendSuccess(res, { controls: {
    keyboardEnabled: controls.keyboardEnabled,
    copyPasteEnabled: controls.copyPasteEnabled,
    aiEnabled: controls.aiEnabled,
    youtubeEnabled: controls.youtubeEnabled,
  }}, 'Controls updated and broadcast to room');
});

// ─── Set Session Media (Teacher Only) ────────────────────────────────────────
/**
 * POST /session/:sessionId/media
 * Teacher sets a YouTube URL or video URL for the session.
 * Creates or updates the MediaSession doc.
 * Students receive current media state when they join.
 */
const setSessionMedia = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const teacher = req.user;
  const { mediaUrl, mediaType, youtubeVideoId } = req.body;

  if (!mediaUrl) return sendError(res, 'mediaUrl is required', 400);

  const session = await Session.findOne({ sessionId, teacherId: teacher._id, status: 'active' });
  if (!session) return sendError(res, 'Active session not found', 404);

  // Robust extraction for shorts, embeds, v=, youtu.be/ formats
  let ytId = youtubeVideoId || null;
  if (!ytId && mediaUrl) {
    const regex = /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
    const match = mediaUrl.match(regex);
    if (match) ytId = match[1];
  }

  // Upsert MediaSession
  const media = await MediaSession.findOneAndUpdate(
    { sessionId: session._id, isActive: true },
    {
      teacherId: teacher._id,
      mediaType: mediaType || 'youtube',
      mediaUrl,
      youtubeVideoId: ytId,
      state: 'idle',
      seekPositionSeconds: 0,
      lastStateChangedAt: new Date(),
      lastStateChangedBy: teacher._id,
      isActive: true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Broadcast to room so students can prepare the player
  const io = getSocketServer();
  if (io) {
    io.to(session.roomId).emit('mediaSet', {
      mediaUrl,
      mediaType: media.mediaType,
      youtubeVideoId: ytId,
      from: teacher._id,
      ts: Date.now(),
    });
  }

  logActivity({
    sessionId: session._id,
    userId: teacher._id,
    actorRole: 'teacher',
    action: 'session.media.set',
    category: 'session',
    details: { mediaUrl, mediaType: media.mediaType },
  });

  return sendSuccess(res, { media }, 'Media set for session. Students will receive mediaSet event.');
});

/**
 * GET /session/:sessionId/media
 * Returns current media state for the session (teacher or student).
 */
const getSessionMedia = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  const mongoose = require('mongoose');
  const isObjId = mongoose.Types.ObjectId.isValid(sessionId);
  const session = await Session.findOne(
    isObjId ? { $or: [{ _id: sessionId }, { sessionId }] } : { sessionId }
  );
  if (!session) return sendError(res, 'Session not found', 404);

  const media = await MediaSession.findOne({ sessionId: session._id, isActive: true }).lean();
  if (!media) return sendSuccess(res, { media: null }, 'No media set for this session');

  return sendSuccess(res, { media });
});

/**
 * @desc    Save session progress during the class
 * @route   POST /api/sessions/save
 */
const saveSessionProgress = asyncHandler(async (req, res) => {
  const { sessionId, canvasData } = req.body;
  const user = req.user;
  const mongoose = require('mongoose');

  const session = await Session.findOne({ 
    $or: [
      { _id: mongoose.isValidObjectId(sessionId) ? sessionId : null }, 
      { sessionId: sessionId }
    ]
  });
  
  if (!session) return sendError(res, 'Session not found', 404);

  // Allow owner OR participant to save
  const isOwner = session.ownerId.toString() === user._id.toString();
  if (!isOwner) {
    const isParticipant = await SessionParticipant.findOne({ sessionId: session._id, userId: user._id });
    if (!isParticipant) return sendError(res, 'Access denied', 403);
  }
  
  if (!session) {
    return sendError(res, 'Session not found', 404);
  }

  if (canvasData) {
    const File = require('../models/File');
    if (session.fileId) {
      // Reopening/Editing: update existing file
      await File.findByIdAndUpdate(session.fileId, { canvasData, lastAutoSavedAt: new Date() });
    } else {
      // New Class: save to linked folder (or default)
      await File.create({
        ownerId: user._id,
        ownerRole: user.role,
        fileType: 'note',
        title: session.title || `Class Notes - ${new Date().toISOString().split('T')[0]}`,
        folderId: session.folderId || null,
        canvasData,
        sessionId: session._id,
      });
      await session.save();
    }

    // Trigger PDF generation job
    addPdfJob({ 
      sessionId: session._id, 
      canvasData, 
      ownerId: user._id, 
      title: session.title 
    }).catch(err => logger.error(`Failed to enqueue manual PDF save: ${err}`));
  }


  return sendSuccess(res, { fileId: session.fileId }, 'Progress saved');
});

// ─── Validation ────────────────────────────────────────────────────────────────

const startSessionValidation = [
  body('title').optional().isString().isLength({ max: 200 }).trim(),
  body('description').optional().isString().isLength({ max: 1000 }).trim(),
];

const joinSessionValidation = [
  body('qrData').notEmpty().withMessage('QR data is required'),
];

const setMediaValidation = [
  body('mediaUrl').notEmpty().isURL().withMessage('Valid mediaUrl required'),
  body('mediaType').optional().isIn(['youtube', 'local', 'stream']).withMessage('Invalid mediaType'),
];

const updateControlsValidation = [
  param('sessionId').notEmpty().withMessage('Session ID required'),
  body('keyboardEnabled').optional().isBoolean(),
  body('copyPasteEnabled').optional().isBoolean(),
  body('aiEnabled').optional().isBoolean(),
  body('youtubeEnabled').optional().isBoolean(),
];

const sessionIdParamValidation = [
  param('sessionId').optional().isString(),
  body('sessionId').optional().isString(),
];

const sessionIdIdParamValidation = [
  param('id').notEmpty().withMessage('ID is required'),
];

// Join teacher's live class by teacher ID
const joinTeacherClass = asyncHandler(async (req, res) => {
  const { teacherId } = req.params;
  const userId = req.user._id;

  // Find teacher's active session
  const Session = require('../models/Session');
  const activeSession = await Session.findOne({
    teacherId,
    status: 'active'
  });

  if (!activeSession) {
    return sendError(res, 'Teacher is not currently live', 404);
  }

  // Check if student already joined
  const SessionParticipant = require('../models/SessionParticipant');
  const existingParticipant = await SessionParticipant.findOne({
    sessionId: activeSession._id,
    userId
  });

  if (existingParticipant) {
    return sendSuccess(res, {
      sessionId: activeSession.sessionId,
      roomId: activeSession.roomId
    }, 'Already joined this session');
  }

  // Add student as participant
  await SessionParticipant.create({
    sessionId: activeSession._id,
    userId,
    joinedAt: new Date(),
    isConnected: true
  });

  return sendSuccess(res, {
    sessionId: activeSession.sessionId,
    roomId: activeSession.roomId
  }, 'Successfully joined teacher class');
});

/**
 * POST /session/:sessionId/refresh-qr
 * Teacher manually refreshes the QR code for a session
 */
const refreshQR = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const user = req.user;

  const session = await Session.findOne({ sessionId, teacherId: user._id });
  if (!session) return sendError(res, 'Session not found or not authorized', 404);
  if (session.status !== 'active') return sendError(res, 'Session is not active', 400);

  const { qrToken, qrCodeDataUrl, qrPayload } = await generateSessionQR(sessionId);

  // Update both the token (for validation) and the data URL (for display)
  session.qrToken = qrToken;
  session.qrCodeDataUrl = qrCodeDataUrl;
  await session.save();

  // Also update cache so fast-path lookups see the new token
  await cache.setJSON(`session:${sessionId}`, {
    _id: session._id.toString(),
    sessionId,
    roomId: session.roomId,
    teacherId: user._id.toString(),
    ownerId: user._id.toString(),
    sessionType: session.sessionType,
    status: 'active',
    qrToken,
  }, 86400);

  logger.info(`QR refreshed for session ${sessionId} by teacher ${user._id}`);

  return sendSuccess(res, { qrCodeDataUrl, qrPayload, qrToken }, 'QR refreshed successfully');
});

module.exports = {
  startSession,
  startSelfSession,
  joinSession,
  joinSessionDirect,
  joinTeacherClass,
  endSession,
  getSession,
  getMySessions,
  getActiveSessionsForClassroom,
  getActiveSessionsByDeskId,
  updateControls,
  setSessionMedia,
  getSessionMedia,
  saveSessionProgress,
  refreshQR,
  
  // Validations
  startSessionValidation,
  joinSessionValidation,
  updateControlsValidation,
  setMediaValidation,
  sessionIdParamValidation,
  sessionIdIdParamValidation
};
