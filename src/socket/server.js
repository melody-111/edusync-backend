'use strict';

const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { verifyAccessToken } = require('../utils/jwt');
const { cache, createRedisClient } = require('../config/redis');
const Session = require('../models/Session');
const SessionParticipant = require('../models/SessionParticipant');
const User = require('../models/User');
const AppControls = require('../models/AppControls');
const Device = require('../models/Device');
const { logActivity } = require('../utils/activityLogger');
const { strokeBatchBuffer } = require('./strokeBuffer');
const logger = require('../utils/logger');
const { escapeRegex } = require('../utils/helpers');

// ─── Module-level io instance (singleton) ─────────────────────────────────────
let _io = null;

const getSocketServer = () => _io;

// ─── Defensive Safe Socket Handler Wrapper ────────────────────────────────────
// Prevents malformed client payloads (e.g. null/primitive args) and unhandled
// exceptions from triggering process-killing uncaught exceptions.
const safeSocketHandler = (eventName, handler, expectsObject = true) => {
  return async (...args) => {
    try {
      if (expectsObject) {
        if (args.length === 0 || args[0] === null || args[0] === undefined || (typeof args[0] !== 'object' && typeof args[0] !== 'function')) {
          args[0] = {};
        }
      }
      return await handler(...args);
    } catch (err) {
      logger.error(`[SOCKET HANDLER DEFENSE] Caught unhandled error in '${eventName}': ${err.message}`, {
        eventName,
        error: err.message,
        stack: err.stack,
      });
    }
  };
};

// ─── School class/section normalizer ──────────────────────────────────────────
// Accepts messy inputs like "11 /A", "Class 11-A", "Grade 11 A", "XI", "11" (+ section)
// Returns { grade: '11', section: 'A' | null }
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
const parseSchoolClass = (className, section) => {
  let raw = String(className || '').trim();
  let grade = null;
  let sec = section && String(section).trim() && String(section).trim().toLowerCase() !== 'null'
    ? String(section).trim().toUpperCase()
    : null;
  if (!raw) return { grade: null, section: sec };
  raw = raw.replace(/^(class|grade|std\.?|standard)\s*/i, '');
  const num = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*[\/\-\s_]*\s*([A-Za-z])?\b/i);
  if (num) {
    grade = String(parseInt(num[1], 10));
    if (!sec && num[2]) sec = num[2].toUpperCase();
  } else {
    const rom = raw.match(/^(xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b\s*[\/\-\s_]*\s*([A-Za-z])?\b/i);
    if (rom) {
      grade = String(ROMAN[rom[1].toLowerCase()]);
      if (!sec && rom[2]) sec = rom[2].toUpperCase();
    }
  }
  return { grade, section: sec };
};

const schoolRoomsForStudent = (tenantPrefix, className, section) => {
  const { grade, section: sec } = parseSchoolClass(className, section);
  if (!grade) return [];
  const base = `school:${tenantPrefix}g:${grade}`;
  return [`${base}:all`, sec ? `${base}:sec:${sec}` : `${base}:nosec`];
};

const schoolRoomsForTeacherTarget = (tenantPrefix, className, section) => {
  const { grade, section: sec } = parseSchoolClass(className, section);
  if (!grade) return [];
  const base = `school:${tenantPrefix}g:${grade}`;
  // Section-specific class also reaches students who never set a section
  return sec ? [`${base}:sec:${sec}`, `${base}:nosec`] : [`${base}:all`];
};

// ─── Tenant Prefix Helper ──────────────────────────────────────────────────────
const computeTenantPrefix = (u) => {
  if (!u) return '';
  if (u.college_id) return `${u.college_id}:`;
  if (u.institutionName) {
    const sanitized = u.institutionName.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
    return `inst_${sanitized}:`;
  }
  return '';
};

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


    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      console.error('[SOCKET AUTH DECODE ERROR]', err.message, 'Token received:', token ? token.substring(0, 20) + '...' : 'none');
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

// ─── Active Live Sessions Cache (Memory-Bounded) ─────────────────────────────
const MAX_LIVE_SESSIONS = 500;
const _liveSessions = new Map(); // roomKey → { notificationPayload, expiresAt }

const setLiveSession = (roomKey, sessionData) => {
  if (_liveSessions.size >= MAX_LIVE_SESSIONS) {
    const now = Date.now();
    for (const [k, v] of _liveSessions.entries()) {
      if (now > v.expiresAt) _liveSessions.delete(k);
    }
    if (_liveSessions.size >= MAX_LIVE_SESSIONS) {
      let count = 0;
      for (const k of _liveSessions.keys()) {
        _liveSessions.delete(k);
        count++;
        if (count >= 50) break;
      }
    }
  }
  _liveSessions.set(roomKey, sessionData);
};

// ─── Active Online Teachers Cache (Real-time Teacher Discovery) ─────────────
const _onlineTeachers = new Map(); // teacherId → { socketId, teacherName, institutionName, className, section, deskId, ... }

// ─── Active Room Canvas Cache (Instant Sync to Joining Students) ────────────
const _roomCanvasCache = new Map(); // roomId → { payload, originalWidth, originalHeight, ts }
const setRoomCanvas = (roomId, payload) => {
  if (!roomId || !payload) return;
  _roomCanvasCache.set(roomId, payload);
  if (cache.isAvailable()) {
    cache.setJSON(`canvas:room:${roomId}`, payload, 10800).catch(() => {});
  }
};
const getRoomCanvas = async (roomId) => {
  if (!roomId) return null;
  if (_roomCanvasCache.has(roomId)) return _roomCanvasCache.get(roomId);
  if (cache.isAvailable()) {
    return await cache.getJSON(`canvas:room:${roomId}`).catch(() => null);
  }
  return null;
};

// ─── Active Teacher Live Room Resolver ─────────────────────────────────────────
const getTeacherActiveLiveSession = (teacherIdentifier) => {
  if (!teacherIdentifier) return null;
  const tid = String(teacherIdentifier).trim().toLowerCase();

  // 1. Search in _liveSessions by teacherId, deskId, or roomId
  for (const [roomKey, data] of _liveSessions.entries()) {
    const np = data?.notificationPayload;
    if (!np) continue;
    if (
      String(np.from || '').toLowerCase() === tid ||
      String(np.teacherDeskId || '').toLowerCase() === tid ||
      String(np.roomId || '').toLowerCase() === tid ||
      roomKey.toLowerCase() === `desk:${tid}` ||
      roomKey.toLowerCase() === `teacher:${tid}`
    ) {
      return {
        roomId: np.roomId,
        sessionId: np.sessionId,
        notificationPayload: np
      };
    }
  }

  // 2. Search in _onlineTeachers
  for (const [teacherId, meta] of _onlineTeachers.entries()) {
    if (
      teacherId.toLowerCase() === tid ||
      String(meta.deskId || '').toLowerCase() === tid
    ) {
      const sock = _io?.sockets?.sockets?.get(meta.socketId);
      const activeRoom = sock?.currentRoomId || [...(sock?.rooms || [])].find(r => r && r.startsWith('room_'));
      if (activeRoom) {
        return {
          roomId: activeRoom,
          sessionId: sock?.currentSessionId,
          meta
        };
      }
    }
  }
  return null;
};

// ─── Room Validation Helper ────────────────────────────────────────────────────
const validateRoomAccess = async (roomId, userId) => {
  // Look up user from cache or DB to determine role and access
  let user = null;
  if (userId) {
    if (cache.isAvailable()) {
      user = await cache.getJSON(`user:${userId}`).catch(() => null);
    }
    if (!user && mongoose.connection.readyState === 1) {
      user = await User.findById(userId).lean().catch(() => null);
    }
  }

  // Look up session by roomId or sessionId, or by teacher deskId/code
  let session = null;
  if (mongoose.connection.readyState === 1) {
    session = await Session.findOne({
      $or: [
        { roomId, status: 'active' },
        { sessionId: roomId, status: 'active' }
      ]
    }).lean().catch(() => null);

    // If roomId looks like a teacher deskId/code (e.g. TCH-254863), resolve to teacher's active session
    if (!session && roomId && (roomId.startsWith('TCH-') || /^[A-Z0-9_-]{4,15}$/i.test(roomId))) {
      const t = await User.findOne({
        $or: [
          { deskId: { $regex: new RegExp(`^${roomId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
          { teacherCode: { $regex: new RegExp(`^${roomId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
        ],
        role: 'teacher'
      }).lean().catch(() => null);
      if (t) {
        session = await Session.findOne({ teacherId: t._id, status: 'active' }).lean().catch(() => null);
      }
    }
  }

      // Fallback 1: If teacher is actively broadcasting via socket (_liveSessions or active teacher room)
      if (!session && roomId) {
        const live = getTeacherActiveLiveSession(roomId);
        if (live) {
          const np = live.notificationPayload || {};
          session = {
            _id: live.sessionId || live.roomId,
            roomId: live.roomId,
            sessionId: live.sessionId || live.roomId,
            status: 'active',
            college_id: np.college_id,
            institutionName: np.institutionName,
            institutionType: np.institutionType || np.targetType,
            className: np.className || np.schoolGrade,
            section: np.section || np.schoolSection,
            branch: np.branch,
            year: np.year,
            semester: np.semester,
            isBroadcasting: true,
            isVirtual: true
          };
        }
      }

      if (!session && _liveSessions.has(roomId)) {
        const liveData = _liveSessions.get(roomId);
        const np = liveData?.notificationPayload || {};
        session = {
          _id: np.sessionId || roomId,
          roomId: roomId,
          sessionId: np.sessionId || roomId,
          status: 'active',
          college_id: np.college_id,
          institutionName: np.institutionName,
          institutionType: np.institutionType || np.targetType,
          className: np.className || np.schoolGrade,
          section: np.section || np.schoolSection,
          branch: np.branch,
          year: np.year,
          semester: np.semester,
          isBroadcasting: true,
          isVirtual: true
        };
      }

  // Fallback 2: Teacher host joins room to initiate class
  if (!session) {
    if (user && user.role === 'teacher') {
      session = {
        _id: roomId,
        roomId: roomId,
        sessionId: roomId,
        status: 'active',
        college_id: user.college_id,
        institutionName: user.institutionName,
        institutionType: user.institutionType || (user.className ? 'school' : 'university'),
        className: user.className,
        section: user.section,
        branch: user.branch,
        year: user.year,
        semester: user.semester,
        isBroadcasting: true,
        isVirtual: true
      };
      setLiveSession(roomId, {
        notificationPayload: {
          roomId,
          sessionId: roomId,
          teacherName: user.name || 'Your Teacher',
          subject: 'Live Class',
          isBroadcasting: true,
          ts: Date.now()
        },
        expiresAt: Date.now() + 3 * 60 * 60 * 1000
      });
    } else {
      return { valid: false, reason: 'Room not found or session ended' };
    }
  }

  // Verify Student Academic Alignment (College, Class, Section, Branch, Semester)
  if (user && user.role === 'student') {
    // 1. Institution match (college_id or institutionName)
    const sInst = (user.institutionName || '').toLowerCase().trim();
    const tInst = (session.institutionName || '').toLowerCase().trim();
    const sCollege = user.college_id ? String(user.college_id) : null;
    const tCollege = session.college_id ? String(session.college_id) : null;

    if (tCollege && sCollege) {
      if (tCollege !== sCollege) {
        return { valid: false, reason: 'Failed to join: You belong to a different institution.' };
      }
    } else if (tInst) {
      if (!sInst || sInst !== tInst) {
        return { valid: false, reason: `Failed to join: Session is for "${session.institutionName}", but your profile has "${user.institutionName || 'no institution'}".` };
      }
    }

    // 2. Mode match (school vs college/university)
    const sMode = (user.institutionType || (user.className ? 'school' : 'university')).toLowerCase();
    const tMode = (session.institutionType || (session.className ? 'school' : 'university')).toLowerCase();
    if (sMode !== tMode) {
      return { valid: false, reason: `Failed to join: Mode mismatch (${tMode === 'school' ? 'School' : 'College'} vs ${sMode === 'school' ? 'School' : 'College'}).` };
    }

    // 3. School Class / Grade match
    if (session.className) {
      const { grade: sGrade } = parseSchoolClass(session.className, session.section);
      const { grade: uGrade } = parseSchoolClass(user.className, user.section);
      if (!uGrade || sGrade !== uGrade) {
        return { valid: false, reason: `Failed to join: Session is for Class ${session.className}, but your profile is Class ${user.className || 'not set'}.` };
      }
    }

    // 4. School Section match
    if (session.section) {
      const sSec = (session.section || '').trim().toUpperCase();
      const uSec = (user.section || '').trim().toUpperCase();
      if (!uSec || sSec !== uSec) {
        return { valid: false, reason: `Failed to join: Session is for Section ${sSec}, but your section is ${uSec || 'not set'}.` };
      }
    }

    // 5. University Branch match
    if (session.branch && session.branch.toLowerCase() !== 'any') {
      const sBranch = (session.branch || '').toLowerCase().trim();
      const uBranch = (user.branch || '').toLowerCase().trim();
      if (!uBranch || sBranch !== uBranch) {
        return { valid: false, reason: `Failed to join: Session is for ${session.branch} branch, but your branch is ${user.branch || 'not set'}.` };
      }
    }

    // 6. University Semester match
    if (session.semester && String(session.semester).toLowerCase() !== 'any') {
      const sSem = String(session.semester || '').trim();
      const uSem = String(user.semester || '').trim();
      if (!uSem || sSem !== uSem) {
        return { valid: false, reason: `Failed to join: Session is for Semester ${session.semester}, but your semester is ${user.semester || 'not set'}.` };
      }
    }
  }

  // Verify user is a participant; if not, enroll them automatically if session is active
  let participant = null;
  if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(session._id)) {
    try {
      participant = await SessionParticipant.findOne({
        sessionId: session._id,
        userId,
      });
      if (!participant) {
        participant = await SessionParticipant.create({
          sessionId: session._id,
          userId,
          role: 'student',
          joinedAt: new Date(),
          isConnected: true,
        });
        await Session.findByIdAndUpdate(session._id, { $inc: { participantCount: 1 } });
      }
    } catch (e) {
      participant = await SessionParticipant.findOne({ sessionId: session._id, userId }).catch(() => null);
    }
  }

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
    perMessageDeflate: false, // Disable per-message compression for lowest latency (<30ms)
    transports: ['websocket'], // Force WebSocket only, disable polling for latency
    allowEIO3: true,
    connectTimeout: 30000,
  });

  // Setup Redis Adapter for multi-instance scaling
  try {
    const pubClient = createRedisClient();
    if (pubClient) {
      const subClient = pubClient.duplicate();
      subClient.on('error', () => {}); // Prevent Unhandled error crash on duplicate client
      pubClient.on('error', () => {});
      let connected = true;
      await Promise.all([
        pubClient.connect().catch((e) => { connected = false; }),
        subClient.connect().catch((e) => { connected = false; })
      ]);
      if (connected && pubClient.status === 'ready' && subClient.status === 'ready') {
        _io.adapter(createAdapter(pubClient, subClient));
        logger.info('Socket.io Redis adapter enabled');
      } else {
        logger.warn('Redis not available for Socket.io adapter. Using in-memory adapter.');
        try { pubClient.disconnect(); } catch (_) {}
        try { subClient.disconnect(); } catch (_) {}
      }
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

    // ─── Anti-Flooding / DoS Protection ───────────────────────────────────────
    // Limits incoming events per socket to prevent CPU choke or event-loop blocking
    // 350 events per 5 seconds gives ample room for 60fps high-rate freehand drawing
    let packetCount = 0;
    let windowStart = Date.now();
    const MAX_EVENTS_PER_WINDOW = 350;
    const WINDOW_MS = 5000;

    socket.use(([event, data], next) => {
      const now = Date.now();
      if (now - windowStart > WINDOW_MS) {
        windowStart = now;
        packetCount = 0;
      }
      packetCount++;
      if (packetCount > MAX_EVENTS_PER_WINDOW) {
        logger.warn(`[SOCKET FLOOD DETECTED] Socket ${socket.id} (user: ${userId}) exceeded rate limit (${packetCount}/${WINDOW_MS}ms). Throttling packet '${event}'.`);
        return next(new Error('Rate limit exceeded. Please slow down event frequency.'));
      }
      next();
    });
    const queryRoomId = socket.handshake.query.roomId;

    if (queryRoomId) {
      socket.join(queryRoomId);
      socket.currentRoomId = queryRoomId;
      logger.debug(`Socket ${userId} joined room from query: ${queryRoomId}`);
    }

    // Join personal room for cross-device syncing (e.g. mobile app sync)
    if (userId) {
      socket.join(userId.toString());
    }

    logger.info(`Socket connected: ${userId} (${userRole}) [${socket.id}]`);

    // Update device socket ID — fire-and-forget, don't await on hot path
    if (!socket.isTerminal) {
      Device.findOneAndUpdate(
        { userId: socket.userId },
        { socketId: socket.id, status: 'online', lastConnectedAt: new Date() }
      ).catch(() => { });
    }

    // ─── Classroom Room Joining (Isolation) ────────────────────────────────────
    if (userRole === 'student' || userRole === 'teacher') {
      const tenantPrefix = computeTenantPrefix(user);

      if (userRole === 'teacher') {
        _onlineTeachers.set(userId.toString(), {
          socketId: socket.id,
          teacherId: userId.toString(),
          teacherName: user.name || 'Teacher',
          institutionName: user.institutionName,
          college_id: user.college_id,
          className: user.className,
          section: user.section,
          branch: user.branch,
          year: user.year,
          semester: user.semester,
          institutionType: user.institutionType || (user.className ? 'school' : 'university'),
          deskId: user.deskId || user.teacherCode,
          connectedAt: Date.now()
        });
      }

      if (user.classroomId) {
        const room = `classroom:${tenantPrefix}${user.classroomId}`;
        socket.join(room);
        logger.debug(`${userRole} ${userId} joined classroom: ${room}`);
      }

      // School Style Targeting (Class Name / Section)
      if (user.className || user.section) {
        const compositeGroup = `school:${tenantPrefix}${user.className || 'any'}:${user.section || 'any'}`;
        socket.join(compositeGroup);
        logger.debug(`${userRole} ${userId} joined school group: ${compositeGroup}`);

        // Fallbacks for school students when teacher inputs "Class X" or "X"
        if (user.className) {
          socket.join(`classroom:${tenantPrefix}${user.className}`);
          socket.join(`classroom:${tenantPrefix}Class ${user.className}`);
          socket.join(`school:${tenantPrefix}${user.className}:any`);
          socket.join(`school:${tenantPrefix}Class ${user.className}:any`);
        }

        // Canonical grade/section rooms (robust to "11 /A", "Class 11-A", etc.)
        if (userRole === 'student') {
          const canonical = schoolRoomsForStudent(tenantPrefix, user.className, user.section);
          canonical.forEach(r => socket.join(r));
          if (canonical.length) logger.debug(`student ${userId} joined canonical school rooms: ${canonical.join(', ')}`);
        }
      }

      // University Style Targeting (Branch / Year / Sem)
      if (user.branch || user.year || user.semester) {
        const compositeGroup = `edu:${tenantPrefix}${user.branch || 'any'}:${user.year || 'any'}:${user.semester || 'any'}`;
        socket.join(compositeGroup);
        logger.debug(`${userRole} ${userId} joined university group: ${compositeGroup}`);
      }

      // Broadcast teacher:online to all target cohort rooms
      if (userRole === 'teacher') {
        const teacherOnlineRooms = new Set();
        if (user.classroomId) teacherOnlineRooms.add(`classroom:${tenantPrefix}${user.classroomId}`);
        if (user.className) {
          teacherOnlineRooms.add(`classroom:${tenantPrefix}${user.className}`);
          teacherOnlineRooms.add(`classroom:${tenantPrefix}Class ${user.className}`);
          teacherOnlineRooms.add(`school:${tenantPrefix}${user.className || 'any'}:${user.section || 'any'}`);
          teacherOnlineRooms.add(`school:${tenantPrefix}${user.className}:any`);
          const canonical = schoolRoomsForTeacherTarget(tenantPrefix, user.className, user.section);
          canonical.forEach(r => teacherOnlineRooms.add(r));
        }
        if (user.branch || user.year || user.semester) {
          teacherOnlineRooms.add(`edu:${tenantPrefix}${user.branch || 'any'}:${user.year || 'any'}:${user.semester || 'any'}`);
        }

        const onlinePayload = {
          teacherId: userId,
          teacherName: user.name || 'Teacher',
          institutionName: user.institutionName,
          className: user.className,
          section: user.section,
          deskId: user.deskId || user.teacherCode,
          message: `${user.name || 'Teacher'} has logged in. Class will start shortly.`
        };

        if (teacherOnlineRooms.size > 0) {
          logger.info(`[SOCKET] Emitting teacher:online for ${user.name} to ${Array.from(teacherOnlineRooms).join(' | ')}`);
          _io.to(Array.from(teacherOnlineRooms)).emit('teacher:online', onlinePayload);
        }
      }

      // ─── Late-Join: If student connects after teacher is already online ────
      if (userRole === 'student') {
        for (const [tId, tData] of _onlineTeachers.entries()) {
          if (tData.institutionName && user.institutionName) {
            if (tData.institutionName.trim().toLowerCase() !== user.institutionName.trim().toLowerCase()) continue;
          }
          if (tData.college_id && user.college_id && String(tData.college_id) !== String(user.college_id)) continue;

          const tMode = tData.institutionType === 'school' ? 'school' : 'college';
          const sMode = (user.institutionType === 'school' || user.className) ? 'school' : 'college';
          if (tMode !== sMode) continue;

          let teacherMatches = false;
          if (sMode === 'school') {
            const { grade: tGrade, section: tSec } = parseSchoolClass(tData.className, tData.section);
            const { grade: sGrade, section: sSec } = parseSchoolClass(user.className, user.section);
            if (tGrade && sGrade && tGrade === sGrade && (!tSec || !sSec || tSec === sSec)) {
              teacherMatches = true;
            }
          } else {
            const branchMatch = !tData.branch || tData.branch === 'any' || tData.branch === user.branch;
            const yearMatch = !tData.year || tData.year === 'any' || tData.year === user.year;
            const semMatch = !tData.semester || tData.semester === 'any' || String(tData.semester) === String(user.semester);
            teacherMatches = branchMatch && yearMatch && semMatch;
          }

          if (teacherMatches) {
            logger.info(`[SOCKET] Aligned teacher ${tData.teacherName} is online. Notifying student ${userId}`);
            socket.emit('teacher:online', {
              teacherId: tData.teacherId,
              teacherName: tData.teacherName,
              institutionName: tData.institutionName,
              className: tData.className,
              section: tData.section,
              deskId: tData.deskId,
              message: `${tData.teacherName} has logged in. Class will start shortly.`
            });
          }
        }
      }

      // ─── Late-Join: If student connects after teacher is already live ────────
      if (userRole === 'student') {
        const studentBranch = user.branch;
        const studentYear = user.year;
        const studentSemester = user.semester;
        const studentInstitution = user.institutionName;
        const studentClassroomId = user.classroomId;
        const sentRoomIds = new Set();

        _liveSessions.forEach((session, roomKey) => {
          // Cleanup expired sessions (> 3 hours)
          if (Date.now() > session.expiresAt) {
            _liveSessions.delete(roomKey);
            return;
          }

          const payload = session.notificationPayload;
          if (sentRoomIds.has(payload.roomId)) return;

          // Strict tenant / institution isolation
          if (payload.college_id && user.college_id && String(payload.college_id) !== String(user.college_id)) {
            return;
          }
          if (payload.institutionName && studentInstitution) {
            if (payload.institutionName.trim().toLowerCase() !== studentInstitution.trim().toLowerCase()) {
              return;
            }
          }
          const pMode = payload.institutionType === 'school' ? 'school' : (payload.schoolGrade || payload.className ? 'school' : 'university');
          const uMode = user.institutionType === 'school' ? 'school' : (user.className ? 'school' : 'university');
          if (pMode !== uMode) {
            return;
          }

          let matches = false;
          if (payload.classroomId && studentClassroomId) {
            matches = payload.classroomId === studentClassroomId;
          } else if (payload.schoolGrade) {
            const st = parseSchoolClass(user.className, user.section);
            matches = !!st.grade && st.grade === payload.schoolGrade &&
              (!payload.schoolSection || !st.section || payload.schoolSection === st.section);
          } else if (payload.branch || payload.year || payload.semester) {
            const branchMatch = !payload.branch || payload.branch === 'any' || payload.branch === studentBranch;
            const yearMatch = !payload.year || payload.year === 'any' || payload.year === studentYear;
            const semMatch = !payload.semester || payload.semester === 'any' || String(payload.semester) === String(studentSemester);
            matches = branchMatch && yearMatch && semMatch;
          }

          if (matches) {
            sentRoomIds.add(payload.roomId);
            logger.info(`[SOCKET] Late-join: Sending existing class:started to student ${userId} for room ${roomKey}`);
            socket.emit('class:started', payload);
          }
        });

        // Also query MongoDB in case server restarted while teacher is live
        if (sentRoomIds.size === 0) {
          (async () => {
            try {
              const query = {
                status: 'active',
                sessionType: 'class',
                isBroadcasting: true,
                startedAt: { $gte: new Date(Date.now() - 3 * 60 * 60 * 1000) }
              };
              if (user.college_id && mongoose.isValidObjectId(user.college_id)) {
                query.college_id = user.college_id;
              } else if (user.institutionName) {
                query.institutionName = { $regex: new RegExp(`^${escapeRegex(user.institutionName.trim())}$`, 'i') };
              }
              const activeSessions = await Session.find(query).populate('teacherId', 'name deskId teacherCode institutionName').lean();
              for (const ses of activeSessions) {
                let matches = false;
                const { grade: sGrade, section: sSec } = parseSchoolClass(ses.className, ses.section);
                const { grade: uGrade, section: uSec } = parseSchoolClass(user.className, user.section);
                if (sGrade && uGrade) {
                  matches = sGrade === uGrade && (!sSec || !uSec || sSec === uSec);
                } else if (ses.branch && user.branch) {
                  matches = ses.branch.toLowerCase().trim() === user.branch.toLowerCase().trim() &&
                    (!ses.semester || !user.semester || String(ses.semester) === String(user.semester));
                }
                if (matches && !sentRoomIds.has(ses.roomId)) {
                  sentRoomIds.add(ses.roomId);
                  const payload = {
                    roomId: ses.roomId,
                    sessionId: ses.sessionId,
                    subject: ses.subject || ses.title || 'Live Class',
                    teacherName: ses.teacherId?.name || 'Your Teacher',
                    teacherDeskId: ses.teacherId?.deskId || ses.teacherId?.teacherCode,
                    className: ses.className,
                    section: ses.section,
                    schoolGrade: sGrade,
                    schoolSection: sSec,
                    branch: ses.branch,
                    year: ses.year,
                    semester: ses.semester,
                    institutionName: ses.institutionName || ses.teacherId?.institutionName || user.institutionName,
                    institutionType: ses.institutionType || (sGrade ? 'school' : 'university'),
                    isBroadcasting: true,
                    ts: Date.now()
                  };
                  socket.emit('class:started', payload);
                }
              }
            } catch (err) {
              logger.warn(`Failed to recover live sessions from DB for student ${userId}: ${err.message}`);
            }
          })();
        }
      }
    }

    // ─── joinTerminal ──────────────────────────────────────────────────────────
    socket.on('joinTerminal', safeSocketHandler('joinTerminal', ({ terminalId } = {}) => {
      if (!terminalId) return;
      socket.join(`terminal:${terminalId}`);
      logger.debug(`Terminal joined room: terminal:${terminalId}`);
    }));

    // ─── callTeacher ──────────────────────────────────────────────────────────
    socket.on('callTeacher', safeSocketHandler('callTeacher', async () => {
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
    }, false));

    // ─── joinClass ─────────────────────────────────────────────────────────────
    socket.on('joinClass', safeSocketHandler('joinClass', async ({ roomId } = {}) => {
      try {
        if (!roomId) return;

        const { valid, session, reason } = await validateRoomAccess(roomId, userId);
        if (!valid) return socket.emit('error', { message: reason });

        let targetRoomId = (session && session.roomId) ? session.roomId : roomId;

        // Leave any previous rooms (isolation)
        const currentRooms = [...socket.rooms].filter((r) => r !== socket.id);
        currentRooms.forEach((r) => socket.leave(r));

        await socket.join(targetRoomId);
        socket.currentRoomId = targetRoomId;
        socket.currentSessionId = session._id.toString();

        // Mark participant as connected
        if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(session._id) && mongoose.isValidObjectId(userId)) {
          await SessionParticipant.findOneAndUpdate(
            { sessionId: session._id, userId },
            { isConnected: true, socketId: socket.id, lastHeartbeatAt: new Date() }
          ).catch(() => {});
        }

        // Send current controls and media to the joining socket
        let controls = null;
        let media = null;
        let currentFile = null;
        if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(session._id)) {
          [controls, media, currentFile] = await Promise.all([
            AppControls.findOne({ sessionId: session._id }).lean().catch(() => null),
            require('../models/MediaSession').findOne({ sessionId: session._id, isActive: true }).lean().catch(() => null),
            require('../models/File').findOne({ sessionId: session._id, isActive: true }).lean().catch(() => null),
          ]);
        }

        // Get current canvas state from active cache (Upstash/memory) or File DB
        let currentCanvasState = await getRoomCanvas(targetRoomId);
        if (!currentCanvasState && currentFile && currentFile.canvasData) {
          try {
            currentCanvasState = JSON.parse(currentFile.canvasData);
          } catch (e) {
            console.error('Failed to parse canvas data:', e);
          }
        }

        socket.emit('joinedClass', {
          roomId: targetRoomId,
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

        // If canvas is already cached, stream directly to student for 0ms instant display
        if (currentCanvasState) {
          socket.emit('draw', {
            ...currentCanvasState,
            from: 'teacher',
            ts: Date.now(),
            isSync: true
          });
          socket.emit('drawData', currentCanvasState);
        }

        // Request current canvas state from teacher for new student
        socket.to(targetRoomId).emit('student-joined', {
          socketId: socket.id,
          userId,
          user: { name: user.name, email: user.email, role: user.role }
        });

        // Notify others in room (teacher)
        socket.to(targetRoomId).emit('studentJoined', {
          userId,
          name: user.name,
          avatar: user.avatar,
          role: userRole,
          socketId: socket.id,
        });

        if (mongoose.connection.readyState === 1 && mongoose.isValidObjectId(session._id) && mongoose.isValidObjectId(userId)) {
          try {
            logActivity({
              sessionId: session._id,
              userId,
              actorRole: userRole,
              action: 'socket.join',
              category: 'session',
            });
          } catch (e) {}
        }
      } catch (err) {
        logger.error(`joinClass error: ${err.message}`);
        socket.emit('error', { message: 'Failed to join class' });
      }
    }));

    // ─── Teacher → Students: draw / drawData (Fabric JSON) ────────────────────
    const handleDraw = async (payload) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId || payload?.roomId || [...socket.rooms].find(r => r.startsWith('room_'));
      if (!roomId) return;
      if (!socket.currentRoomId && roomId) socket.currentRoomId = roomId;

      // Cache latest canvas frame for zero-latency student sync
      setRoomCanvas(roomId, payload);

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

    socket.on('draw', safeSocketHandler('draw', handleDraw));
    socket.on('drawData', safeSocketHandler('drawData', handleDraw));
    socket.on('drawing', safeSocketHandler('drawing', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId || payload?.roomId || [...socket.rooms].find(r => r.startsWith('room_'));
      if (!roomId) return;
      if (!socket.currentRoomId && roomId) socket.currentRoomId = roomId;
      socket.to(roomId).emit('drawing', payload);
    }));

    // Targeted sync for joining students
    socket.on('draw:sync', safeSocketHandler('draw:sync', async ({ targetSocketId, payload } = {}) => {
      if (userRole !== 'teacher' || !targetSocketId) return;
      const roomId = socket.currentRoomId || payload?.roomId || [...socket.rooms].find(r => r.startsWith('room_'));
      if (roomId && payload) {
        setRoomCanvas(roomId, payload);
      }
      _io.to(targetSocketId).emit('draw', {
        ...payload,
        from: userId,
        ts: Date.now(),
        isSync: true // Flag to indicate this is a full sync
      });
      _io.to(targetSocketId).emit('drawData', payload);
    }));

    // Student requests instant canvas sync
    socket.on('canvas:request', safeSocketHandler('canvas:request', async () => {
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      const cached = await getRoomCanvas(roomId);
      if (cached) {
        socket.emit('draw', {
          ...cached,
          from: 'teacher',
          ts: Date.now(),
          isSync: true
        });
        socket.emit('drawData', cached);
      }
      socket.to(roomId).emit('student-joined', {
        socketId: socket.id,
        userId,
        user: { name: user?.name, email: user?.email, role: userRole }
      });
    }));

    // ─── Student → Backend: draw (80% Area - Personal Only) ───────────────────
    socket.on('draw:student', safeSocketHandler('draw:student', async (payload = {}) => {
      if (userRole !== 'student') return;
      strokeBatchBuffer.add(socket.currentSessionId, userId, 'student', payload);

      // Broadcast to teacher for 20% preview (in the same room)
      socket.to(socket.currentRoomId).emit('student:draw', {
        ...payload,
        studentId: userId,
        studentName: user.name,
        ts: Date.now()
      });
    }));

    // ─── Student → Teacher: State Tracking (Idle, Writing, YouTube, AI) ───────────
    socket.on('student:state:update', safeSocketHandler('student:state:update', (payload = {}) => {
      if (userRole !== 'student') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      
      // Update session participant state in DB occasionally if needed, but primarily broadcast real-time
      socket.to(roomId).emit('student:state:changed', {
        studentId: userId,
        socketId: socket.id,
        studentName: user.name,
        state: payload.state,
        ts: Date.now()
      });
    }));

    // ─── Teacher → Student: Requests (Assignments, Notes) ───────────
    socket.on('teacher:request:assignment', safeSocketHandler('teacher:request:assignment', (payload = {}) => {
      if (userRole !== 'teacher') return;
      if (payload.targetSocketId) {
        _io.to(payload.targetSocketId).emit('teacher:requested:assignment', {
           message: payload.message || 'Teacher requested your assignment.',
           teacherName: user.name
        });
      }
    }));

    socket.on('teacher:request:notes', safeSocketHandler('teacher:request:notes', (payload = {}) => {
      if (userRole !== 'teacher') return;
      if (payload.targetSocketId) {
        _io.to(payload.targetSocketId).emit('teacher:requested:notes', {
           message: payload.message || 'Teacher requested your written notes.',
           teacherName: user.name
        });
      }
    }));
    // ─── Teacher → Student: Block / Kick Student from Classroom ───────────────
    socket.on('teacher:block:student', safeSocketHandler('teacher:block:student', async (payload = {}) => {
      if (userRole !== 'teacher') return;
      const { targetSocketId, targetStudentId, studentName, reason } = payload || {};
      const roomId = socket.currentRoomId;
      logger.warn(`Teacher ${user.name} blocked student ${studentName || targetStudentId}`);

      const blockMsg = reason || 'You have been removed from this live class by the teacher.';

      if (targetSocketId) {
        _io.to(targetSocketId).emit('student:blocked', {
          message: blockMsg,
          teacherName: user.name,
        });
        // Disconnect or force target socket to leave the room
        const targetSocket = _io.sockets.sockets?.get(targetSocketId);
        if (targetSocket && roomId) {
          targetSocket.leave(roomId);
          targetSocket.currentRoomId = null;
        }
      }

      if (targetStudentId) {
        _io.to(targetStudentId.toString()).emit('student:blocked', {
          message: blockMsg,
          teacherName: user.name,
        });
      }

      // Notify classroom that student left
      if (roomId) {
        socket.to(roomId).emit('studentLeft', {
          userId: targetStudentId,
          socketId: targetSocketId,
          isBlocked: true,
        });
      }
    }));

    // ─── Teacher → Students: Start Exam (Real-time distribution) ───────────────
    socket.on('teacher:start:exam', safeSocketHandler('teacher:start:exam', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      logger.info(`Teacher ${user.name} broadcasted exam: ${payload?.title}`);
      if (roomId) {
        socket.to(roomId).emit('exam:started', {
          ...payload,
          teacherName: user.name,
          ts: Date.now(),
        });
      } else {
        _io.emit('exam:started', {
          ...payload,
          teacherName: user.name,
          ts: Date.now(),
        });
      }
    }));

    // ─── Student → Teacher: Exam Submission Real-time Alert ───────────────────
    socket.on('student:submit:exam', safeSocketHandler('student:submit:exam', (payload = {}) => {
      if (userRole !== 'student') return;
      const roomId = socket.currentRoomId;
      logger.info(`Student ${user.name} submitted exam: ${payload?.examId}`);
      if (roomId) {
        socket.to(roomId).emit('exam:submission:received', {
          ...payload,
          studentId: userId,
          studentName: user.name,
          ts: Date.now(),
        });
      }
    }));

    // ─── Teacher → Students: Coding Mode ──────────────────────────────────────
    socket.on('code:mode:toggle', safeSocketHandler('code:mode:toggle', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('code:mode:toggle', { ...payload, from: userId, ts: Date.now() });
    }));

    socket.on('code:sync:teacher', safeSocketHandler('code:sync:teacher', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('code:sync:teacher', { ...payload, from: userId, ts: Date.now() });
    }));

    socket.on('code:sync:student', safeSocketHandler('code:sync:student', (payload = {}) => {
      if (userRole !== 'student') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      // Emit to teacher only, or to the room. For now, broadcast to the room so teacher can see it.
      socket.to(roomId).emit('code:sync:student', { ...payload, studentId: userId, studentName: user.name, ts: Date.now() });
    }));

    // ─── Teacher → Students: pageChange ──────────────────────────────────────
    socket.on('pageChange', safeSocketHandler('pageChange', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('pageChange', { ...payload, from: userId, ts: Date.now() });
    }));

    // ─── Teacher → Students: clearCanvas ─────────────────────────────────────
    socket.on('clearCanvas', safeSocketHandler('clearCanvas', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('clearCanvas', { ...payload, from: userId, ts: Date.now() });
    }));

    // ─── Teacher → Students: fileOpen ────────────────────────────────────────
    socket.on('fileOpen', safeSocketHandler('fileOpen', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      socket.to(roomId).emit('fileOpen', { ...payload, from: userId, ts: Date.now() });
    }));

    // ─── Video Control Events (Teacher Only) ──────────────────────────────────
    socket.on('videoPlay', safeSocketHandler('videoPlay', async (payload = {}) => {
      if (userRole !== 'teacher') {
        socket.emit('error', { message: 'Only teacher can control video' });
        return;
      }
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      // Persist media state
      await updateMediaSessionState(socket.currentSessionId, userId, 'playing', payload.seekTo);
      socket.to(roomId).emit('videoPlay', { ...payload, from: userId, ts: Date.now() });
    }));

    socket.on('videoPause', safeSocketHandler('videoPause', async (payload = {}) => {
      if (userRole !== 'teacher') {
        socket.emit('error', { message: 'Only teacher can control video' });
        return;
      }
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      await updateMediaSessionState(socket.currentSessionId, userId, 'paused', payload.seekTo);
      socket.to(roomId).emit('videoPause', { ...payload, from: userId, ts: Date.now() });
    }));

    socket.on('videoSeek', safeSocketHandler('videoSeek', async (payload = {}) => {
      if (userRole !== 'teacher') {
        socket.emit('error', { message: 'Only teacher can control video' });
        return;
      }
      const roomId = socket.currentRoomId;
      if (!roomId) return;
      await updateMediaSessionState(socket.currentSessionId, userId, 'playing', payload.position);
      socket.to(roomId).emit('videoSeek', { ...payload, from: userId, ts: Date.now() });
    }));

    // ─── Teacher → Students: mediaSet / mediaState (Socket bypass for speed) ──
    socket.on('mediaSet', safeSocketHandler('mediaSet', async (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      // Also persisting via helper for consistency
      await updateMediaSessionState(socket.currentSessionId, userId, 'idle', 0, {
        youtubeVideoId: payload.youtubeVideoId,
        mediaUrl: payload.mediaUrl
      });

      socket.to(roomId).emit('mediaSet', { ...payload, from: userId, ts: Date.now() });
    }));

    socket.on('mediaState', safeSocketHandler('mediaState', async (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      await updateMediaSessionState(socket.currentSessionId, userId, payload.state, payload.seekTo || payload.position);
      socket.to(roomId).emit('mediaState', { ...payload, from: userId, ts: Date.now() });
    }));

    // ─── Student → Backend: keyboardInput ─────────────────────────────────────
    socket.on('keyboardInput', safeSocketHandler('keyboardInput', async (payload = {}) => {
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
    }));

    // ─── Teacher → Students: broadcastState (Toggle broadcast) ──────────────
    socket.on('broadcastState', safeSocketHandler('broadcastState', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId || payload?.roomId;
      if (!roomId) return;
      socket.to(roomId).emit('broadcastState', { ...payload, from: userId, ts: Date.now() });

      if (payload?.broadcasting === false) {
        socket.to(roomId).emit('class:ended', { roomId, ts: Date.now() });
        _liveSessions.delete(roomId);
        if (user.deskId) _liveSessions.delete(`desk:${user.deskId.toUpperCase()}`);
        if (userId) _liveSessions.delete(`teacher:${userId}`);
        for (const [key, sess] of _liveSessions.entries()) {
          if (sess.notificationPayload?.roomId === roomId || sess.notificationPayload?.from === userId) {
            _liveSessions.delete(key);
          }
        }
        Session.findOneAndUpdate({ $or: [{ roomId }, { teacherId: userId, status: 'active' }] }, { isBroadcasting: false }).catch(() => {});
      }
    }));

    // ─── Teacher → Students: class:ended (Explicit end of live broadcast) ──────
    socket.on('class:ended', safeSocketHandler('class:ended', ({ roomId, sessionId } = {}) => {
      if (userRole !== 'teacher') return;
      const targetRoom = roomId || socket.currentRoomId;
      if (targetRoom) {
        socket.to(targetRoom).emit('class:ended', { roomId: targetRoom, sessionId, ts: Date.now() });
        _liveSessions.delete(targetRoom);
        if (user.deskId) _liveSessions.delete(`desk:${user.deskId.toUpperCase()}`);
        if (userId) _liveSessions.delete(`teacher:${userId}`);
        for (const [key, sess] of _liveSessions.entries()) {
          if (sess.notificationPayload?.roomId === targetRoom || sess.notificationPayload?.from === userId) {
            _liveSessions.delete(key);
          }
        }
      }
      Session.findOneAndUpdate(
        { $or: [{ sessionId }, { roomId: targetRoom }, { teacherId: userId, status: 'active' }] },
        { isBroadcasting: false }
      ).catch(() => {});
    }));

    // ─── Teacher → Students: class:upcoming:alert (Upcoming Class Soon) ────────
    socket.on('class:upcoming:alert', safeSocketHandler('class:upcoming:alert', async (payload = {}) => {
      if (userRole !== 'teacher') return;

      const teacherName = user.name || 'Your Teacher';
      const subject = payload.subject || user.subjectName || user.subject || 'Upcoming Class';
      const tenantPrefix = computeTenantPrefix(user);
      const isSchoolTarget = payload.targetType === 'school' || (!!payload.className && !payload.branch) || user.institutionType === 'school';
      const schoolTarget = isSchoolTarget
        ? parseSchoolClass(payload.className || user.className, payload.section || user.section)
        : { grade: null, section: null };

      const instName = user.institutionName || payload.institutionName;
      const instType = user.institutionType || payload.institutionType || (isSchoolTarget ? 'school' : 'university');

      const alertPayload = {
        ...payload,
        teacherId: userId.toString(),
        teacherName,
        subject,
        institutionName: instName,
        institutionType: instType,
        college_id: user.college_id ? String(user.college_id) : null,
        schoolGrade: schoolTarget.grade,
        schoolSection: schoolTarget.section,
        className: payload.className || user.className || schoolTarget.grade,
        section: payload.section || user.section || schoolTarget.section,
        branch: payload.branch || user.branch,
        year: payload.year || user.year,
        semester: payload.semester || user.semester,
        deskId: user.deskId || user.teacherCode,
        isUpcoming: true,
        message: payload.message || `Upcoming class soon: ${teacherName} has scheduled a ${subject} class. Please get ready!`,
        ts: Date.now()
      };

      const targetRooms = new Set();
      if (isSchoolTarget && schoolTarget.grade) {
        schoolRoomsForTeacherTarget(tenantPrefix, payload.className || user.className, payload.section || user.section)
          .forEach(r => targetRooms.add(r));
        targetRooms.add(`classroom:${tenantPrefix}${schoolTarget.grade}`);
        targetRooms.add(`classroom:${tenantPrefix}Class ${schoolTarget.grade}`);
        targetRooms.add(`school:${tenantPrefix}${schoolTarget.grade}:any`);
      } else if (payload.branch || user.branch) {
        const b = payload.branch || user.branch;
        const y = payload.year || user.year || 'any';
        const s = payload.semester || user.semester || 'any';
        targetRooms.add(`edu:${tenantPrefix}${b}:${y}:${s}`);
        targetRooms.add(`edu:${tenantPrefix}${b}:any:any`);
      }

      if (targetRooms.size > 0) {
        logger.info(`[SOCKET] Emitting class:upcoming:alert for ${teacherName} to rooms: ${Array.from(targetRooms).join(' | ')}`);
        _io.to(Array.from(targetRooms)).emit('class:upcoming:alert', alertPayload);
        _io.to(Array.from(targetRooms)).emit('teacher:online', alertPayload);
      }
    }));

    // ─── Teacher → All Students: class:started (Notify when class starts) ──────
    socket.on('class:started', safeSocketHandler('class:started', async (payload = {}) => {
      console.log(`[SOCKET] Received class:started from ${userId} (${userRole})`, payload);

      if (userRole !== 'teacher') {
        console.warn(`[SOCKET] Rejecting class:started from non-teacher: ${userRole}`);
        return;
      }

      const teacherName = user.name || 'Your Teacher';
      const subject = payload.subject || 'Live Class';

      const tenantPrefix = computeTenantPrefix(user);
      const isSchoolTarget = payload.targetType === 'school' || (!!payload.classroomId && !payload.branch);
      const schoolTarget = isSchoolTarget
        ? parseSchoolClass(payload.className || payload.classroomId, payload.section)
        : { grade: null, section: null };

      const tenantId = user.college_id ? String(user.college_id) : (user.institutionName ? user.institutionName.trim().toLowerCase() : null);
      const instName = user.institutionName || payload.institutionName;
      const instType = user.institutionType || payload.institutionType || (isSchoolTarget ? 'school' : 'university');

      const notificationPayload = {
        ...payload,
        from: userId,
        teacherName,
        subject,
        tenantId,
        institutionName: instName,
        institutionType: instType,
        college_id: user.college_id ? String(user.college_id) : null,
        schoolGrade: schoolTarget.grade,
        schoolSection: schoolTarget.section,
        className: payload.className || schoolTarget.grade,
        section: payload.section || schoolTarget.section,
        branch: payload.branch,
        year: payload.year,
        semester: payload.semester,
        isBroadcasting: true,
        startTime: new Date(),
        ts: Date.now()
      };

      // 1. Target specific rooms based on teacher's payload
      const targetRooms = new Set();
      if (payload.roomId) targetRooms.add(payload.roomId);

      if (isSchoolTarget && schoolTarget.grade) {
        schoolRoomsForTeacherTarget(tenantPrefix, payload.className || payload.classroomId, payload.section)
          .forEach(r => targetRooms.add(r));
        targetRooms.add(`school:${tenantPrefix}${payload.className || 'any'}:${payload.section || 'any'}`);
        targetRooms.add(`school:${tenantPrefix}${schoolTarget.grade}:${schoolTarget.section || 'any'}`);
        targetRooms.add(`school:${tenantPrefix}${schoolTarget.grade}:any`);
        targetRooms.add(`classroom:${tenantPrefix}${schoolTarget.grade}`);
        targetRooms.add(`classroom:${tenantPrefix}Class ${schoolTarget.grade}`);
      }

      if (payload.classroomId) {
        targetRooms.add(`classroom:${tenantPrefix}${payload.classroomId}`);
      } else if (payload.branch && payload.year && payload.semester) {
        targetRooms.add(`edu:${tenantPrefix}${payload.branch}:${payload.year}:${payload.semester}`);
      } else if (payload.branch) {
        targetRooms.add(`edu:${tenantPrefix}${payload.branch}:${payload.year || 'any'}:${payload.semester || 'any'}`);
      } else {
        // Fallback to teacher's base profile if payload doesn't specify targeting
        if (user.classroomId) targetRooms.add(`classroom:${tenantPrefix}${user.classroomId}`);
        if (user.branch && user.year && user.semester) {
          targetRooms.add(`edu:${tenantPrefix}${user.branch}:${user.year}:${user.semester}`);
        }
      }

      // Single multi-room emit → socket.io de-duplicates, so a student in several
      // matching rooms gets exactly one alert.
      if (targetRooms.size > 0) {
        console.log(`[SOCKET] Emitting class:started to rooms: ${Array.from(targetRooms).join(' | ')}`);
        _io.to(Array.from(targetRooms)).emit('class:started', notificationPayload);
      }
      targetRooms.forEach(room => {
        // Cache this live session so late-joining students can receive it
        setLiveSession(room, {
          notificationPayload,
          expiresAt: Date.now() + 3 * 60 * 60 * 1000 // 3 hours TTL
        });
      });

      // Also cache by teacher desk ID and teacher user ID for fast direct lookup
      if (user.deskId || payload.teacherDeskId) {
        setLiveSession(`desk:${(user.deskId || payload.teacherDeskId).toUpperCase()}`, {
          notificationPayload,
          expiresAt: Date.now() + 3 * 60 * 60 * 1000
        });
      }
      if (userId) {
        setLiveSession(`teacher:${userId}`, {
          notificationPayload,
          expiresAt: Date.now() + 3 * 60 * 60 * 1000
        });
      }

      // Mark session as broadcasting in DB and ensure active session has this exact roomId
      if (userId) {
        const updateData = {
          roomId: payload.roomId,
          sessionId: payload.sessionId || `session_${Date.now()}`,
          isBroadcasting: true,
          ...(payload.className ? { className: payload.className } : {}),
          ...(payload.section ? { section: payload.section } : {}),
          ...(payload.branch ? { branch: payload.branch } : {}),
          ...(payload.semester ? { semester: payload.semester } : {}),
          ...(payload.year ? { year: payload.year } : {}),
          ...(payload.subject ? { subject: payload.subject } : {}),
        };
        Session.findOneAndUpdate(
          { teacherId: userId, status: 'active' },
          { $set: updateData },
          { sort: { startedAt: -1 } }
        ).catch((err) => logger.error(`Failed to update active session on class:started: ${err.message}`));
      } else if (payload.sessionId || payload.roomId) {
        Session.findOneAndUpdate(
          { $or: [{ sessionId: payload.sessionId }, { roomId: payload.roomId }] },
          { isBroadcasting: true }
        ).catch(() => {});
      }

      // Global fallback removed to ensure strict student targeting based on matching criteria
      // Verification log
      console.log(`[SOCKET] Broadcast complete for ${subject} to ${targetRooms.size} targeted rooms. Live sessions cached: ${_liveSessions.size}`);

      // 3. 🆕 Mobile Push Notifications
      try {
        const { sendPushNotification } = require('../utils/push');
        const Device = require('../models/Device');

        // Find students in this cohort/classroom based on strict matching
        const query = { role: 'student' };
        if (user.college_id && mongoose.isValidObjectId(user.college_id)) {
          query.college_id = user.college_id;
        }

        if (isSchoolTarget && schoolTarget.grade) {
          query.className = { $regex: new RegExp(`^\\s*(class|grade)?\\s*${escapeRegex(schoolTarget.grade)}(\\b|\\D)`, 'i') };
        } else if (payload.classroomId) {
          query.classroomId = payload.classroomId;
        } else if (payload.branch) {
          query.branch = payload.branch;
          if (payload.year) query.year = payload.year;
          if (payload.semester) query.semester = payload.semester;
        } else if (user.classroomId) {
          query.classroomId = user.classroomId;
        } else if (user.branch) {
          query.branch = user.branch;
          query.year = user.year;
          query.semester = user.semester;
        }

        const User = require('../models/User');
        const studentIds = (await User.find(query).select('_id')).map(s => s._id);

        if (studentIds.length > 0) {
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
    }));

    // ─── Control Update broadcast by teacher ──────────────────────────────────
    socket.on('controlUpdate', safeSocketHandler('controlUpdate', (payload = {}) => {
      if (userRole !== 'teacher') return;
      const roomId = socket.currentRoomId;
      if (!roomId) return;

      const normalizedPayload = { ...payload };
      if (payload.aiAccess !== undefined) normalizedPayload.aiEnabled = payload.aiAccess;
      if (payload.youtubeAccess !== undefined) normalizedPayload.youtubeEnabled = payload.youtubeAccess;

      socket.to(roomId).emit('controlUpdate', { ...normalizedPayload, from: userId, ts: Date.now() });
    }));

    // ─── Teacher → Students: view-change (Redirect between Canvas/YouTube) ──
    socket.on('view-change', safeSocketHandler('view-change', async (payload = {}) => {
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
    }));

    // ─── Student → Backend: copyPasteEvent ────────────────────────────────────
    socket.on('copyPasteEvent', safeSocketHandler('copyPasteEvent', async (payload = {}) => {
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
    }));

    // ─── Heartbeat ────────────────────────────────────────────────────────────
    // PERF: Debounced DB write — buffer heartbeats in memory, flush every 30s.
    // Without this: 1M users × 1 heartbeat/10s = 100K DB writes/second → crash.
    socket.on('heartbeat', safeSocketHandler('heartbeat', () => {
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
    }, false));

    // ─── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', safeSocketHandler('disconnect', async (reason) => {
      logger.debug(`Socket disconnected: ${userId} — ${reason}`);

      if (userRole === 'teacher' && userId) {
        _onlineTeachers.delete(userId.toString());
      }

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

      if (!socket.isTerminal && userId && mongoose.isValidObjectId(userId)) {
        logActivity({
          sessionId: socket.currentSessionId || null,
          userId,
          actorRole: ['teacher', 'student', 'admin'].includes(userRole) ? userRole : 'system',
          action: 'socket.disconnect',
          category: 'session',
          details: { reason },
        });
      }
    }, false));

    // ─── Reconnect ────────────────────────────────────────────────────────────
    socket.on('reconnect', safeSocketHandler('reconnect', () => {
      if (socket.currentSessionId) {
        SessionParticipant.findOneAndUpdate(
          { sessionId: socket.currentSessionId, userId },
          { $inc: { reconnectCount: 1 }, isConnected: true, socketId: socket.id }
        ).catch(() => { });
      }
    }, false));
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

module.exports = { initSocketServer, getSocketServer, notifyTerminalSynced, getTeacherActiveLiveSession, getRoomCanvas };
