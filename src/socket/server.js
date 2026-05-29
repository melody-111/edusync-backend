'use strict';

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { verifyAccessToken } = require('../utils/jwt');
const { cache, createRedisClient } = require('../config/redis');
const Session = require('../models/Session');
const SessionParticipant = require('../models/SessionParticipant');
const AppControls = require('../models/AppControls');
const Device = require('../models/Device');
const { logActivity } = require('../utils/activityLogger');
const { strokeBatchBuffer } = require('./strokeBuffer');
const logger = require('../utils/logger');

// ─── Module-level io instance (singleton) ─────────────────────────────────────
let _io = null;

const getSocketServer = () => _io;

// ─── Socket Auth Middleware ────────────────────────────────────────────────────
const authenticateSocket = async (socket, next) => {
  try {
    const terminalId =
      socket.handshake.auth?.terminalId ||
      socket.handshake.query?.terminalId ||
      socket.handshake.headers?.['x-terminal-id'];

    if (terminalId) {
      // Allow terminal connection without a user token if terminalId is provided
      // This is used by desktops waiting for a QR scan login
      socket.isTerminal = true;
      socket.terminalId = terminalId;
      socket.userId = `terminal:${terminalId}`;
      socket.userRole = 'terminal';
      return next();
    }

    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) return next(new Error('Authentication token required'));

    // ─── Dev Mode Bypass ──────────────────────────────────────────────────────
    if (token === 'dev_token_secret' || token === 'dev_teacher_secret') {
      socket.userId = token === 'dev_token_secret' ? '65c2a1e8f1d2e3b4c5d6e7f9' : '65c2a1e8f1d2e3b4c5d6e7f8';
      socket.userRole = token === 'dev_token_secret' ? 'student' : 'teacher';
      socket.user = {
        _id: socket.userId,
        name: 'Dev User',
        role: socket.userRole,
        classroomId: 'Class 1',
        branch: 'CS',
        year: '3rd',
        semester: '6'
      };
      socket.isTerminal = false;
      return next();
    }

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch {
      return next(new Error('Invalid or expired token'));
    }

    // Check blacklist
    const blacklisted = await cache.exists(`blacklist:${decoded.jti}`);
    if (blacklisted) return next(new Error('Token revoked'));

    // Load user from cache
    let user = await cache.getJSON(`user:${decoded.sub}`);
    if (!user) {
      const User = require('../models/User');
      try {
        user = await User.findById(decoded.sub).lean();
      } catch {
        return next(new Error('User not found'));
      }
      if (!user) return next(new Error('User not found'));
      await cache.setJSON(`user:${decoded.sub}`, user, 300);
    }

    if (!user.isActive) return next(new Error('Account disabled'));

    socket.user = user;
    socket.userId = user._id.toString();
    socket.userRole = user.role;
    socket.isTerminal = false;
    return next();
  } catch (err) {
    logger.error(`Socket auth error: ${err.message}`);
    return next(new Error('Authentication failed'));
  }
};

// ─── Room Validation Helper ────────────────────────────────────────────────────
const validateRoomAccess = async (roomId, userId) => {
  // Dev Mode Bypass for local testing without DB records
  if (userId === '65c2a1e8f1d2e3b4c5d6e7f9' || userId === '65c2a1e8f1d2e3b4c5d6e7f8') {
    return {
      valid: true,
      session: { _id: 'mock_session_123', sessionId: 'mock_session_123' },
      participant: {}
    };
  }

  // Look up session by roomId
  const session = await Session.findOne({ roomId, status: 'active' }).lean();
  if (!session) return { valid: false, reason: 'Room not found or session ended' };

  // Verify user is a participant
  const participant = await SessionParticipant.findOne({
    sessionId: session._id,
    userId,
  });
  if (!participant) return { valid: false, reason: 'Not a participant of this session' };

  return { valid: true, session, participant };
};

// ─── Initialize Socket.io Server ──────────────────────────────────────────────
const initSocketServer = async (httpServer) => {
  _io = new Server(httpServer, {
    cors: {
      origin: '*', // Relaxed for cross-device/mobile connectivity
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 5e6, // 5MB limit per message
    perMessageDeflate: {
      threshold: 1024, // only compress messages > 1kb
    },
    transports: ['websocket', 'polling'], // Essential for iOS/Android fallback
    allowEIO3: true,
    connectTimeout: 30000,
  });

  // Setup Redis Adapter for multi-instance scaling
  try {
    const pubClient = createRedisClient();
    if (pubClient) {
      const subClient = pubClient.duplicate();
      await Promise.all([
        pubClient.connect().catch(() => { }),
        subClient.connect().catch(() => { })
      ]);
      _io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.io Redis adapter enabled');
    }
  } catch (err) {
    logger.warn(`Failed to setup Redis adapter: ${err.message}. Using single-instance memory adapter.`);
  }

  // Apply auth middleware globally
  _io.use(authenticateSocket);

  // ─── Connection Handler ──────────────────────────────────────────────────────
  // ─── Per-connection heartbeat debounce map ──────────────────────────────────
  // Prevents DB write on EVERY heartbeat ping (would be millions of writes/min at scale)
  const _heartbeatTimers = new Map();

  _io.on('connection', (socket) => {
    const { user, userId, userRole } = socket;
    const queryRoomId = socket.handshake.query.roomId;

    if (queryRoomId) {
      socket.join(queryRoomId);
      socket.currentRoomId = queryRoomId;
      logger.debug(`Socket ${userId} joined room from query: ${queryRoomId}`);
    }

    logger.info(`Socket connected: ${userId} (${userRole}) [${socket.id}]`);

    // Update device socket ID — fire-and-forget, don't await on hot path
    if (!socket.isTerminal) {
      Device.findOneAndUpdate(
        { socketId: socket.id, status: 'online', lastConnectedAt: new Date() }
      ).catch(() => { });
    }

    // ─── Classroom Room Joining (Isolation) ────────────────────────────────────
    if (userRole === 'student' || userRole === 'teacher') {
      if (user.classroomId) {
        const room = `classroom:${user.classroomId}`;
        socket.join(room);
        logger.debug(`${userRole} ${userId} joined classroom: ${room}`);

        // If teacher, notify students in this room
        if (userRole === 'teacher') {
          socket.to(room).emit('teacher:online', {
            teacherId: userId,
            teacherName: user.name,
            message: `${user.name} is online.`
          });
        }
      }

      // University Style Targeting (Branch / Year / Sem)
      if (user.branch || user.year || user.semester) {
        const compositeGroup = `edu:${user.branch || 'any'}:${user.year || 'any'}:${user.semester || 'any'}`;
        socket.join(compositeGroup);
        logger.debug(`${userRole} ${userId} joined university group: ${compositeGroup}`);

        // If teacher, notify students in this group
        if (userRole === 'teacher') {
          socket.to(compositeGroup).emit('teacher:online', {
            teacherId: userId,
            teacherName: user.name,
            message: `${user.name} is online.`
          });
        }
      }
    }

    // ─── joinTerminal ──────────────────────────────────────────────────────────
    socket.on('joinTerminal', ({ terminalId }) => {
      if (!terminalId) return;
      socket.join(`terminal:${terminalId}`);
      logger.debug(`Terminal joined room: terminal:${terminalId}`);
    });

    // ─── callTeacher ──────────────────────────────────────────────────────────
    socket.on('callTeacher', async () => {
      if (socket.userRole !== 'student') return;

      const Device = require('../models/Device');
      const Session = require('../models/Session');

      // Find the active session for this student's room
      // In this system, one student usually belongs to one room at a time
      const session = await Session.findOne({ roomId: socket.currentRoomId, status: 'active' });
      if (!session) return;

      // Find teacher's online devices
      const teacherDevices = await Device.find({
        userId: session.teacherId,
        status: 'online',
        deviceType: 'mobile'
      });

      const notificationData = {
        title: 'Help Required!',
        body: `${socket.user.name} is calling for assistance in Room ${session.roomId}`,
        data: {
          type: 'STUDENT_CALL',
          studentId: socket.userId,
          roomId: session.roomId
        }
      };

      // Notify via Sockets (Real-time)
      teacherDevices.forEach(dev => {
        _io.to(dev.socketId).emit('student:call', notificationData);
      });

      // Also send Push Notification if FCM is active
      const { sendPushNotification } = require('../utils/push');
      const tokens = teacherDevices.map(d => d.fcmToken).filter(Boolean);
      if (tokens.length > 0) {
        await sendPushNotification(tokens, notificationData.title, notificationData.body, notificationData.data);
      }

      logger.info(`Student ${socket.userId} called teacher ${session.teacherId}`);
    });

    // ─── joinClass ─────────────────────────────────────────────────────────────
    socket.on('joinClass', async ({ roomId }) => {
      try {
        if (!roomId) return;

        socket.join(roomId);
        socket.currentRoomId = roomId;

        const { valid, session, reason } = await validateRoomAccess(roomId, userId);
        if (!valid) return socket.emit('error', { message: reason });

        // Leave any previous rooms (isolation)
        const currentRooms = [...socket.rooms].filter((r) => r !== socket.id);
        currentRooms.forEach((r) => socket.leave(r));

        await socket.join(roomId);
        socket.currentRoomId = roomId;
        socket.currentSessionId = session._id.toString();

        // Mark participant as connected
        await SessionParticipant.findOneAndUpdate(
          { sessionId: session._id, userId },
          { isConnected: true, socketId: socket.id, lastHeartbeatAt: new Date() }
        );

        // Send current controls and media to the joining socket
        const [controls, media, currentFile] = await Promise.all([
          AppControls.findOne({ sessionId: session._id }).lean(),
          require('../models/MediaSession').findOne({ sessionId: session._id, isActive: true }).lean(),
          require('../models/File').findOne({ sessionId: session._id, isActive: true }).lean(),
        ]);

        // Get current canvas state from the most recent file or page
        let currentCanvasState = null;
        if (currentFile && currentFile.canvasData) {
          try {
            currentCanvasState = JSON.parse(currentFile.canvasData);
          } catch (e) {
            console.error('Failed to parse canvas data:', e);
          }
        }

        socket.emit('joinedClass', {
          roomId,
          sessionId: session.sessionId,
          controls: controls
            ? {
              keyboardEnabled: controls.keyboardEnabled,
              copyPasteEnabled: controls.copyPasteEnabled,
              aiEnabled: controls.aiEnabled,
              youtubeEnabled: controls.youtubeEnabled,
            }
            : {},
          media: media ? {
            mediaUrl: media.mediaUrl,
            mediaType: media.mediaType,
            youtubeVideoId: media.youtubeVideoId,
            state: media.state,
            seekTo: media.seekPositionSeconds,
          } : null,
          canvasData: currentCanvasState,
        });

        // Request current canvas state from teacher for new student
        socket.to(roomId).emit('student-joined', {
          socketId: socket.id,
          userId,
          user: { name: user.name, email: user.email, role: user.role }
        });

        // Notify others in room (teacher)
        socket.to(roomId).emit('studentJoined', {
          userId,
          name: user.name,
          avatar: user.avatar,
          role: userRole,
          socketId: socket.id,
        });

        logActivity({
          sessionId: session._id,
          userId,
          actorRole: userRole,
          action: 'socket.join',
          category: 'session',
        });
      } catch (err) {
        logger.error(`joinClass error: ${err.message}`);
        socket.emit('error', { message: 'Failed to join class' });
      }
    });



    // ─── Teacher → Students: draw / drawData (Fabric JSON) ────────────────────
    const handleDraw = async (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      // Buffer stroke for batch DB write (fire-and-forget)
      strokeBatchBuffer.add(socket.currentSessionId, userId, 'teacher', payload);

      // Broadcast to room
      socket.to(roomId).emit('draw', {
        ...payload,
        from: userId,
        ts: Date.now(),
      });
      // Also emit drawData for older clients if any
      socket.to(roomId).emit('drawData', payload);
    };

    socket.on('draw', handleDraw);
    socket.on('drawData', handleDraw);
    socket.on('drawing', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('drawing', payload);
    });

    // Targeted sync for joining students
    socket.on('draw:sync', async ({ targetSocketId, payload }) => {
      if (userRole !== 'teacher' || !targetSocketId) return;
      io.to(targetSocketId).emit('draw', {
        ...payload,
        from: userId,
        ts: Date.now(),
        isSync: true // Flag to indicate this is a full sync
      });
    });

    // ─── Student → Backend: draw (80% Area - Personal Only) ───────────────────
    socket.on('draw:student', async (payload) => {
      if (userRole !== 'student') return;
      strokeBatchBuffer.add(socket.currentSessionId, userId, 'student', payload);

      // Broadcast to teacher for 20% preview (in the same room)
      socket.to(socket.currentRoomId).emit('student:draw', {
        ...payload,
        studentId: userId,
        studentName: user.name,
        ts: Date.now()
      });
    });

    // ─── Teacher → Students: Coding Mode ──────────────────────────────────────
    socket.on('code:mode:toggle', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('code:mode:toggle', { ...payload, from: userId, ts: Date.now() });
    });

    socket.on('code:sync:teacher', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('code:sync:teacher', { ...payload, from: userId, ts: Date.now() });
    });

    socket.on('code:sync:student', (payload) => {
      if (userRole !== 'student') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      // Emit to teacher only, or to the room. For now, broadcast to the room so teacher can see it.
      socket.to(roomId).emit('code:sync:student', { ...payload, studentId: userId, studentName: user.name, ts: Date.now() });
    });

    // ─── Teacher → Students: pageChange ──────────────────────────────────────
    socket.on('pageChange', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('pageChange', { ...payload, from: userId, ts: Date.now() });
    });

    // ─── Teacher → Students: clearCanvas ─────────────────────────────────────
    socket.on('clearCanvas', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('clearCanvas', { ...payload, from: userId, ts: Date.now() });
    });

    // ─── Teacher → Students: fileOpen ────────────────────────────────────────
    socket.on('fileOpen', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('fileOpen', { ...payload, from: userId, ts: Date.now() });
    });

    // ─── Video Control Events (Teacher Only) ──────────────────────────────────
    socket.on('videoPlay', async (payload) => {
      if (userRole !== 'teacher') {
        socket.emit('error', { message: 'Only teacher can control video' });
        return;
      }
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      // Persist media state
      await updateMediaSessionState(socket.currentSessionId, userId, 'playing', payload.seekTo);
      socket.to(roomId).emit('videoPlay', { ...payload, from: userId, ts: Date.now() });
    });

    socket.on('videoPause', async (payload) => {
      if (userRole !== 'teacher') {
        socket.emit('error', { message: 'Only teacher can control video' });
        return;
      }
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      await updateMediaSessionState(socket.currentSessionId, userId, 'paused', payload.seekTo);
      socket.to(roomId).emit('videoPause', { ...payload, from: userId, ts: Date.now() });
    });

    socket.on('videoSeek', async (payload) => {
      if (userRole !== 'teacher') {
        socket.emit('error', { message: 'Only teacher can control video' });
        return;
      }
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      await updateMediaSessionState(socket.currentSessionId, userId, 'playing', payload.position);
      socket.to(roomId).emit('videoSeek', { ...payload, from: userId, ts: Date.now() });
    });

    // ─── Teacher → Students: mediaSet / mediaState (Socket bypass for speed) ──
    socket.on('mediaSet', async (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      // Also persisting via helper for consistency
      await updateMediaSessionState(socket.currentSessionId, userId, 'idle', 0, {
        youtubeVideoId: payload.youtubeVideoId,
        mediaUrl: payload.mediaUrl
      });

      socket.to(roomId).emit('mediaSet', { ...payload, from: userId, ts: Date.now() });
    });

    socket.on('mediaState', async (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      await updateMediaSessionState(socket.currentSessionId, userId, payload.state, payload.seekTo || payload.position);
      socket.to(roomId).emit('mediaState', { ...payload, from: userId, ts: Date.now() });
    });

    // ─── Student → Backend: keyboardInput ─────────────────────────────────────
    socket.on('keyboardInput', async (payload) => {
      if (userRole !== 'student') return;
      const allowed = await isControlAllowed(socket.currentSessionId, userId, 'keyboardEnabled');
      if (!allowed) return socket.emit('error', { message: 'Keyboard disabled' });

      logActivity({
        sessionId: socket.currentSessionId,
        userId,
        actorRole: 'student',
        action: 'student.keyboardInput',
        category: 'canvas',
        details: { type: payload.type },
      });
      socket.emit('keyboardInputAck', { received: true, ts: Date.now() });
    });

    // ─── Teacher → Students: broadcastState (Toggle broadcast) ──────────────
    socket.on('broadcastState', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('broadcastState', { ...payload, from: userId, ts: Date.now() });
    });

    // ─── Teacher → All Students: class:started (Notify when class starts) ──────
    socket.on('class:started', async (payload) => {
      console.log(`[SOCKET] Received class:started from ${userId} (${userRole})`, payload);

      if (userRole !== 'teacher') {
        console.warn(`[SOCKET] Rejecting class:started from non-teacher: ${userRole}`);
        return;
      }

      const teacherName = user.name || 'Your Teacher';
      const subject = payload.subject || 'Live Class';

      const notificationPayload = {
        ...payload,
        from: userId,
        teacherName,
        subject,
        startTime: new Date(),
        ts: Date.now()
      };

      // 1. Target specific rooms
      const targetRooms = new Set();
      if (payload.roomId) targetRooms.add(payload.roomId);
      if (user.classroomId) targetRooms.add(`classroom:${user.classroomId}`);
      if (user.branch && user.year && user.semester) {
        targetRooms.add(`edu:${user.branch}:${user.year}:${user.semester}`);
      }

      targetRooms.forEach(room => {
        console.log(`[SOCKET] Emitting class:started to target room: ${room}`);
        _io.to(room).emit('class:started', notificationPayload);
      });

      // 2. Global fallback (for students not in specific rooms)
      console.log(`[SOCKET] Emitting class:started globally to all connected clients`);
      _io.emit('class:started', notificationPayload);

      // Verification log
      console.log(`[SOCKET] Broadcast complete for ${subject}`);

      // 3. 🆕 Mobile Push Notifications
      try {
        const { sendPushNotification } = require('../utils/push');
        const Device = require('../models/Device');

        // Find students in this cohort/classroom
        const query = { role: 'student' };
        if (user.classroomId) query.classroomId = user.classroomId;
        else if (user.branch) {
          query.branch = user.branch;
          query.year = user.year;
          query.semester = user.semester;
        }

        const User = require('../models/User');
        const studentIds = (await User.find(query).select('_id')).map(s => s._id);

        if (studentIds.length > 0 || socket.userId === '65c2a1e8f1d2e3b4c5d6e7f8') {
          // For dev mode, we might not have real DB users, so we can't find tokens easily
          // but we'll try for any online student devices
          const studentDevices = await Device.find({
            userId: { $in: studentIds },
            status: 'online',
            fcmToken: { $exists: true }
          });

          const tokens = studentDevices.map(d => d.fcmToken);
          if (tokens.length > 0) {
            await sendPushNotification(
              tokens,
              'Class is Live!',
              `${teacherName} started ${subject}. Join now!`,
              { type: 'CLASS_STARTED', roomId: payload.roomId || user.classroomId }
            );
          }
        }
      } catch (err) {
        logger.error('Failed to send class started push notifications:', err.message);
      }

      logger.info(`Class started by teacher ${userId} [${teacherName}] in ${targetRooms.size} targeted rooms`);
    });

    // ─── Control Update broadcast by teacher ──────────────────────────────────
    socket.on('controlUpdate', (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      const normalizedPayload = { ...payload };
      if (payload.aiAccess !== undefined) normalizedPayload.aiEnabled = payload.aiAccess;
      if (payload.youtubeAccess !== undefined) normalizedPayload.youtubeEnabled = payload.youtubeAccess;

      socket.to(roomId).emit('controlUpdate', { ...normalizedPayload, from: userId, ts: Date.now() });
    });

    // ─── Teacher → Students: view-change (Redirect between Canvas/YouTube) ──
    socket.on('view-change', async (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      try {
        await Session.findByIdAndUpdate(socket.currentSessionId, {
          activeView: payload.view,
          activeYouTubeVideoId: payload.videoId || null
        });
      } catch (err) {
        logger.error(`Failed to persist view-change: ${err.message}`);
      }

      socket.to(roomId).emit('view-change', {
        view: payload.view,
        videoId: payload.videoId,
        from: userId,
        ts: Date.now()
      });
    });

    // ─── Student → Backend: copyPasteEvent ────────────────────────────────────
    socket.on('copyPasteEvent', async (payload) => {
      if (userRole !== 'student') return;
      const allowed = await isControlAllowed(socket.currentSessionId, userId, 'copyPasteEnabled');
      if (!allowed) {
        socket.emit('error', { message: 'Copy/paste is disabled' });
        return;
      }
      logActivity({
        sessionId: socket.currentSessionId,
        userId,
        actorRole: 'student',
        action: 'student.copyPaste',
        category: 'canvas',
        details: { operation: payload.operation },
      });
      socket.emit('copyPasteAck', { allowed: true });
    });

    // ─── Heartbeat ────────────────────────────────────────────────────────────
    // PERF: Debounced DB write — buffer heartbeats in memory, flush every 30s.
    // Without this: 1M users × 1 heartbeat/10s = 100K DB writes/second → crash.
    socket.on('heartbeat', () => {
      socket.emit('heartbeatAck', { ts: Date.now() }); // Instant ACK — never delay this

      if (!socket.currentSessionId) return;

      // Clear existing timer for this socket and set a new debounced flush
      const existingTimer = _heartbeatTimers.get(socket.id);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        _heartbeatTimers.delete(socket.id);
        SessionParticipant.findOneAndUpdate(
          { sessionId: socket.currentSessionId, userId },
          { lastHeartbeatAt: new Date() }
        ).catch(() => { });
      }, 30_000); // Write to DB at most once per 30 seconds per socket

      _heartbeatTimers.set(socket.id, timer);
    });

    // ─── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.debug(`Socket disconnected: ${userId} — ${reason}`);

      // Cleanup debounce timer for this socket
      const timer = _heartbeatTimers.get(socket.id);
      if (timer) {
        clearTimeout(timer);
        _heartbeatTimers.delete(socket.id);
      }

      if (socket.currentSessionId) {
        await SessionParticipant.findOneAndUpdate(
          { sessionId: socket.currentSessionId, userId },
          { isConnected: false, leftAt: new Date(), socketId: null }
        ).catch(() => { });

        // Notify room of disconnect
        if (socket.currentRoomId) {
          socket.to(socket.currentRoomId).emit('participantDisconnected', {
            userId,
            name: user.name,
            role: userRole,
            ts: Date.now(),
          });
        }

        // Flush any buffered strokes for this user
        strokeBatchBuffer.flush(socket.currentSessionId, userId).catch(() => { });
      }

      await Device.findOneAndUpdate(
        { socketId: socket.id },
        { status: 'offline', socketId: null, lastSeenAt: new Date() }
      ).catch(() => { });

      logActivity({
        sessionId: socket.currentSessionId || null,
        userId,
        actorRole: userRole,
        action: 'socket.disconnect',
        category: 'session',
        details: { reason },
      });
    });

    // ─── Reconnect ────────────────────────────────────────────────────────────
    socket.on('reconnect', () => {
      if (socket.currentSessionId) {
        SessionParticipant.findOneAndUpdate(
          { sessionId: socket.currentSessionId, userId },
          { $inc: { reconnectCount: 1 }, isConnected: true, socketId: socket.id }
        ).catch(() => { });
      }
    });
  });

  logger.info('Socket.io server initialized');
  return _io;
};

// ─── Helper: Check control permission ────────────────────────────────────────
// PERF: Caches controls in Redis for 30s to prevent DB hit on every
// keyboardInput / copyPasteEvent socket event (millions/min at scale).
const isControlAllowed = async (sessionId, userId, control) => {
  if (!sessionId) return false;

  const cacheKey = `controls:${sessionId}`;
  let controls = await cache.getJSON(cacheKey);

  if (!controls) {
    controls = await AppControls.findOne({ sessionId }).lean();
    if (!controls) return false;
    // Cache for 30 seconds — teacher control changes still propagate
    // immediately via socket 'controlUpdate' event anyway
    await cache.setJSON(cacheKey, controls, 30);
  }

  // Check per-student override first
  const overrides = controls.studentOverrides || {};
  const override = overrides[userId.toString()];
  if (override && override[control] !== undefined) return override[control];

  return controls[control];
};

// ─── Helper: Update media session state ───────────────────────────────────────
const updateMediaSessionState = async (sessionId, userId, state, position) => {
  try {
    const MediaSession = require('../models/MediaSession');
    await MediaSession.findOneAndUpdate(
      { sessionId, isActive: true },
      {
        state,
        seekPositionSeconds: position || 0,
        lastStateChangedAt: new Date(),
        lastStateChangedBy: userId,
      }
    );
  } catch (err) {
    logger.error(`MediaSession update error: ${err.message}`);
  }
};

// ─── Helper: Notify Terminal Synced ──────────────────────────────────────────
const notifyTerminalSynced = (terminalId, data) => {
  if (!_io) return;
  _io.to(`terminal:${terminalId}`).emit('terminal:synced', data);
};

module.exports = { initSocketServer, getSocketServer, notifyTerminalSynced };
