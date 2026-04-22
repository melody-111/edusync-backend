'use strict';

const User = require('../models/User');
const Session = require('../models/Session');
const Classroom = require('../models/Classroom');
const Device = require('../models/Device');
const { asyncHandler, sendSuccess, sendError, paginate } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');

// ─── Global Stats ───────────────────────────────────────────────────────────
exports.getGlobalStats = asyncHandler(async (req, res) => {
  const [userCount, activeSessions, classrooms, onlineDevices, teacherCount, studentCount] = await Promise.all([
    User.countDocuments(),
    Session.countDocuments({ status: 'active' }),
    Classroom.countDocuments({ isActive: true }),
    Device.countDocuments({ status: 'online' }),
    User.countDocuments({ role: 'teacher' }),
    User.countDocuments({ role: 'student' }),
  ]);

  return sendSuccess(res, {
    totalUsers: userCount,
    teacherCount,
    studentCount,
    activeSessions,
    totalClassrooms: classrooms,
    onlineDevices,
  });
});

// ─── All Users ──────────────────────────────────────────────────────────────
exports.getAllUsers = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, role, isActive } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (isActive !== undefined) filter.isActive = isActive === 'true';

  const { docs, pagination } = await paginate(User, filter, {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    sort: { createdAt: -1 },
  });

  return sendSuccess(res, { users: docs, pagination });
});

// ─── All Sessions ───────────────────────────────────────────────────────────
exports.getAllSessions = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, status } = req.query;
  const filter = status ? { status } : {};

  const { docs, pagination } = await paginate(Session, filter, {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    sort: { startedAt: -1 },
    populate: { path: 'teacherId', select: 'name email' },
  });

  return sendSuccess(res, { sessions: docs, pagination });
});

// ─── Activate / Deactivate User ─────────────────────────────────────────────
/**
 * PUT /admin/users/:id/status
 * Body: { isActive: true | false }
 * Admin can ban or unban any user.
 */
exports.updateUserStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;

  if (typeof isActive !== 'boolean') {
    return sendError(res, 'isActive must be a boolean (true or false)', 400);
  }

  const user = await User.findByIdAndUpdate(
    id,
    { isActive },
    { new: true }
  );

  if (!user) return sendError(res, 'User not found', 404);

  // If deactivating — force-expire their tokens by logging online devices offline
  if (!isActive) {
    await Device.updateMany({ userId: id }, { status: 'offline', activeSessionId: null });
  }

  logActivity({
    userId: req.user._id,
    actorRole: 'system',
    action: isActive ? 'admin.user.activate' : 'admin.user.deactivate',
    category: 'system',
    details: { targetUserId: id },
  });

  return sendSuccess(
    res,
    { userId: user._id, name: user.name, isActive: user.isActive },
    `User has been ${isActive ? 'activated' : 'deactivated'}`
  );
});

// ─── Change User Role ──────────────────────────────────────────────────────
/**
 * PUT /admin/users/:id/role
 * Body: { role: 'teacher' | 'student' }
 * Admin can promote a student to teacher or demote.
 */
exports.updateUserRole = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!['teacher', 'student'].includes(role)) {
    return sendError(res, "role must be 'teacher' or 'student'", 400);
  }

  const user = await User.findByIdAndUpdate(id, { role }, { new: true });
  if (!user) return sendError(res, 'User not found', 404);

  logActivity({
    userId: req.user._id,
    actorRole: 'system',
    action: 'admin.user.role.change',
    category: 'system',
    details: { targetUserId: id, newRole: role },
  });

  return sendSuccess(
    res,
    { userId: user._id, name: user.name, role: user.role },
    `User role updated to ${role}`
  );
});

