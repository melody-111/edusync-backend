'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const Classroom = require('../models/Classroom');
const Device = require('../models/Device');
const College = require('../models/College');
const { cache } = require('../config/redis');
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

// ─── College Management ──────────────────────────────────────────────────────

/**
 * POST /admin/colleges
 * Create a new college and generate a unique code.
 * Body: { name: 'DPS Delhi', domain: 'dps.edu' }
 */
exports.createCollege = asyncHandler(async (req, res) => {
  const { name, domain, address, contact_email, contact_phone, max_students, max_teachers } = req.body;
  if (!name) return sendError(res, 'College name is required', 400);

  // Generate a clean unique code (e.g., DPS-101)
  const firstWord = name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '') || 'COL';
  const prefix = firstWord.substring(0, 4);
  const existingCount = await College.countDocuments({ collegeCode: new RegExp('^' + prefix, 'i') });
  const collegeCode = `${prefix}-${101 + existingCount}`;

  const college = await College.create({
    name,
    domain: domain || `${collegeCode.toLowerCase()}.edu`,
    collegeCode,
    address: address || null,
    contact_email: contact_email || null,
    contact_phone: contact_phone || null,
    max_students: max_students || 500,
    max_teachers: max_teachers || 50,
    isActive: true,
    status: 'active',
    subscriptionStatus: 'active'
  });

  return sendSuccess(res, { college, collegeCode: college.collegeCode }, 'College created successfully', 201);
});

/**
 * GET /admin/colleges
 * List all colleges with summary stats
 */
exports.getColleges = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, search } = req.query;
  const filter = {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { collegeCode: { $regex: search, $options: 'i' } }
    ];
  }

  const [totalColleges, totalStudents, totalTeachers, paginationResult] = await Promise.all([
    College.countDocuments(filter),
    User.countDocuments({ role: 'student' }),
    User.countDocuments({ role: 'teacher' }),
    paginate(College, filter, {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { createdAt: -1 }
    })
  ]);

  // Count students and teachers per college
  const collegesWithStats = await Promise.all(paginationResult.docs.map(async (col) => {
    const colObj = col.toObject ? col.toObject() : col;
    const studentCount = await User.countDocuments({ 
      role: 'student', 
      $or: [{ college_id: col._id }, { institutionName: col.name }] 
    });
    const teacherCount = await User.countDocuments({ 
      role: 'teacher', 
      $or: [{ college_id: col._id }, { institutionName: col.name }] 
    });
    return {
      ...colObj,
      studentCount,
      teacherCount
    };
  }));

  const textSummary = `Total ${totalColleges} Schools, ${totalStudents} Students, ${totalTeachers} Teachers`;

  return sendSuccess(res, {
    summary: {
      totalSchools: totalColleges,
      totalStudents,
      totalTeachers,
      textSummary
    },
    colleges: collegesWithStats,
    pagination: paginationResult.pagination
  });
});

/**
 * PUT /admin/colleges/:id/block
 * Block or unblock a college and immediately terminate sessions
 */
exports.toggleCollegeBlock = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  // Find college by _id or collegeCode
  const query = mongoose.isValidObjectId(id) ? { _id: id } : { collegeCode: id.toUpperCase() };
  const college = await College.findOne(query);
  if (!college) return sendError(res, 'College/School not found', 404);

  college.isActive = !college.isActive;
  college.status = college.isActive ? 'active' : 'suspended';
  await college.save();

  // If blocked, immediately terminate all user sessions & devices associated with this college
  if (!college.isActive) {
    const users = await User.find({ 
      $or: [{ college_id: college._id }, { institutionName: college.name }] 
    }, '_id');
    const userIds = users.map(u => u._id);

    if (userIds.length > 0) {
      await Device.updateMany(
        { userId: { $in: userIds } }, 
        { status: 'offline', activeSessionId: null }
      );

      for (const uid of userIds) {
        await cache.del(`user:${uid}`);
      }
    }
  }

  const message = college.isActive
    ? `School '${college.name}' (${college.collegeCode}) has been successfully unblocked and activated.`
    : `School '${college.name}' (${college.collegeCode}) has been successfully blocked. All associated student and teacher sessions have been terminated immediately.`;

  return sendSuccess(res, { 
    college,
    blocked: !college.isActive,
    status: college.status,
    message
  }, message);
});

