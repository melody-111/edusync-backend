'use strict';

const { body, param } = require('express-validator');
const Classroom = require('../models/Classroom');
const Session = require('../models/Session');
const { asyncHandler, sendSuccess, sendError, paginate } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');

// ─── Create Classroom ─────────────────────────────────────────────────────────
const createClassroom = asyncHandler(async (req, res) => {
  const { name, description, subject, grade, maxStudents } = req.body;
  const teacher = req.user;

  const classroom = await Classroom.create({
    name,
    description: description || '',
    teacherId: teacher._id,
    subject: subject || '',
    grade: grade || '',
    maxStudents: maxStudents || 100,
  });

  logActivity({
    userId: teacher._id,
    actorRole: 'teacher',
    action: 'classroom.create',
    category: 'session',
    details: { classroomId: classroom._id, name },
  });

  return sendSuccess(res, { classroom }, 'Classroom created', 201);
});

// ─── Get My Classrooms (teacher) ──────────────────────────────────────────────
const getMyClassrooms = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const { docs: classrooms, pagination } = await paginate(
    Classroom,
    { teacherId: req.user._id, isActive: true },
    {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { createdAt: -1 },
      populate: { path: 'students.userId', select: 'name email avatar' },
    }
  );

  return sendSuccess(res, { classrooms, pagination });
});

// ─── Get Single Classroom ─────────────────────────────────────────────────────
const getClassroom = asyncHandler(async (req, res) => {
  const classroom = await Classroom.findOne({
    $or: [{ _id: req.params.id }, { code: req.params.id.toUpperCase() }],
    isActive: true,
  })
    .populate('students.userId', 'name email avatar')
    .populate('teacherId', 'name email avatar')
    .lean();

  if (!classroom) return sendError(res, 'Classroom not found', 404);

  // Access: teacher or enrolled student
  const isTeacher = classroom.teacherId._id.toString() === req.user._id.toString();
  const isStudent = classroom.students.some(
    (s) => s.userId?._id?.toString() === req.user._id.toString()
  );
  if (!isTeacher && !isStudent) return sendError(res, 'Access denied', 403);

  return sendSuccess(res, { classroom });
});

// ─── Update Classroom ─────────────────────────────────────────────────────────
const updateClassroom = asyncHandler(async (req, res) => {
  const { name, description, subject, grade, maxStudents } = req.body;

  const classroom = await Classroom.findOneAndUpdate(
    { _id: req.params.id, teacherId: req.user._id, isActive: true },
    { name, description, subject, grade, maxStudents },
    { new: true, runValidators: true }
  );
  if (!classroom) return sendError(res, 'Classroom not found or not yours', 404);

  return sendSuccess(res, { classroom }, 'Classroom updated');
});

// ─── Delete Classroom (soft) ──────────────────────────────────────────────────
const deleteClassroom = asyncHandler(async (req, res) => {
  const classroom = await Classroom.findOneAndUpdate(
    { _id: req.params.id, teacherId: req.user._id },
    { isActive: false },
    { new: true }
  );
  if (!classroom) return sendError(res, 'Classroom not found', 404);
  return sendSuccess(res, null, 'Classroom deleted');
});

// ─── Enroll Student ───────────────────────────────────────────────────────────
const enrollStudent = asyncHandler(async (req, res) => {
  const { classroomCode } = req.body;
  const student = req.user;

  const classroom = await Classroom.findOne({ code: classroomCode.toUpperCase(), isActive: true });
  if (!classroom) return sendError(res, 'Classroom not found. Check the code.', 404);

  const alreadyEnrolled = classroom.students.some(
    (s) => s.userId.toString() === student._id.toString()
  );
  if (alreadyEnrolled) return sendError(res, 'Already enrolled in this classroom', 409);

  if (classroom.students.length >= classroom.maxStudents) {
    return sendError(res, 'Classroom is full', 403);
  }

  classroom.students.push({ userId: student._id, joinedAt: new Date(), isActive: true });
  await classroom.save();

  logActivity({
    userId: student._id,
    actorRole: 'student',
    action: 'classroom.enroll',
    category: 'session',
    details: { classroomId: classroom._id },
  });

  return sendSuccess(res, { classroomId: classroom._id, name: classroom.name, code: classroom.code }, 'Enrolled successfully');
});

// ─── Leave Classroom ──────────────────────────────────────────────────────────
const leaveClassroom = asyncHandler(async (req, res) => {
  const classroom = await Classroom.findById(req.params.id);
  if (!classroom) return sendError(res, 'Classroom not found', 404);

  classroom.students = classroom.students.map((s) =>
    s.userId.toString() === req.user._id.toString() ? { ...s.toObject(), isActive: false } : s
  );
  await classroom.save();
  return sendSuccess(res, null, 'Left classroom');
});

// ─── Get Classroom Sessions ───────────────────────────────────────────────────
const getClassroomSessions = asyncHandler(async (req, res) => {
  const classroom = await Classroom.findById(req.params.id).lean();
  if (!classroom) return sendError(res, 'Classroom not found', 404);

  const sessions = await Session.find({ classroomId: classroom._id })
    .sort({ startedAt: -1 })
    .limit(50)
    .lean();

  return sendSuccess(res, { sessions });
});

// ─── Student's Enrolled Classrooms ───────────────────────────────────────────
const getEnrolledClassrooms = asyncHandler(async (req, res) => {
  const classrooms = await Classroom.find({
    'students.userId': req.user._id,
    'students.isActive': true,
    isActive: true,
  })
    .populate('teacherId', 'name email avatar')
    .lean();

  return sendSuccess(res, { classrooms });
});

// ─── Get Student Dashboard Recorded Classes ──────────────────────────────────
const getRecordedClasses = asyncHandler(async (req, res) => {
  // Fetch sessions where end time exists (meaning class is over and recorded)
  const recordings = await Session.find({ status: 'ended' })
    .populate('teacherId', 'name')
    .sort({ endedAt: -1 })
    .limit(10)
    .lean();

  const formatted = recordings.map(rec => ({
    id: rec._id,
    title: rec.title || 'Recorded Lecture',
    subject: 'Subject', // would ideally populate from Classroom
    teacher: rec.teacherId?.name || 'Instructor',
    duration: '45 min', // can compute from startedAt/endedAt
    date: rec.endedAt ? new Date(rec.endedAt).toLocaleDateString() : 'Recent',
    color: '#10b981'
  }));

  return sendSuccess(res, formatted);
});

// ─── Get All Students in College (Teacher) ────────────────────────────────────
const getCollegeStudents = asyncHandler(async (req, res) => {
  const User = require('../models/User');
  if (!req.user.college_id) {
    return sendError(res, 'You are not assigned to any college', 403);
  }

  // Fetch all students in the same college
  const students = await User.find({
    college_id: req.user.college_id,
    role: 'student'
  })
    .select('name email avatar isVerified isActive')
    .lean();

  // For a unified "block" status, we could check if they are blocked in ANY of the teacher's classrooms.
  // To keep it simple, we will return the students, and the frontend will map them.
  // Fetch teacher's classrooms
  const classrooms = await Classroom.find({ teacherId: req.user._id }).lean();
  
  // Create a block map: studentId -> true/false
  const blockMap = {};
  classrooms.forEach(c => {
    c.students.forEach(s => {
      if (s.isBlocked) {
        blockMap[s.userId.toString()] = true;
      }
    });
  });

  const formattedStudents = students.map(s => ({
    id: s._id,
    name: s.name,
    email: s.email,
    status: s.isActive ? 'online' : 'offline', // simplified mock status
    isBlocked: blockMap[s._id.toString()] || false,
    avatar: s.avatar
  }));

  return sendSuccess(res, formattedStudents);
});

// ─── Block/Unblock Student in Teacher's Classrooms ────────────────────────────
const toggleBlockStudent = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  
  // Find all classrooms of this teacher where this student is enrolled
  const classrooms = await Classroom.find({ teacherId: req.user._id, 'students.userId': studentId });
  
  if (!classrooms || classrooms.length === 0) {
    return sendError(res, 'Student is not enrolled in any of your classrooms', 404);
  }

  let isBlockedNow = false;
  
  // Toggle block status across all classrooms taught by this teacher
  for (const classroom of classrooms) {
    const studentIndex = classroom.students.findIndex(s => s.userId.toString() === studentId);
    if (studentIndex > -1) {
      classroom.students[studentIndex].isBlocked = !classroom.students[studentIndex].isBlocked;
      isBlockedNow = classroom.students[studentIndex].isBlocked;
      await classroom.save();
    }
  }

  return sendSuccess(res, { studentId, isBlocked: isBlockedNow }, `Student has been ${isBlockedNow ? 'blocked' : 'unblocked'} in your classrooms`);
});

// ─── Validation ───────────────────────────────────────────────────────────────
const createClassroomValidation = [
  body('name').notEmpty().isString().isLength({ max: 100 }).trim().withMessage('Classroom name required'),
  body('description').optional().isString().isLength({ max: 500 }),
  body('maxStudents').optional().isInt({ min: 1, max: 500 }),
];

const enrollValidation = [
  body('classroomCode').notEmpty().isString().trim().withMessage('Classroom code required'),
];

const updateClassroomValidation = [
  param('id').isMongoId().withMessage('Invalid classroom ID'),
  body('name').optional().notEmpty().isString().isLength({ max: 100 }).trim(),
  body('maxStudents').optional().isInt({ min: 1, max: 500 }),
];

const classroomIdParamValidation = [
  param('id').isMongoId().withMessage('Invalid classroom ID'),
];

const studentIdParamValidation = [
  param('studentId').isMongoId().withMessage('Invalid student ID'),
];

module.exports = {
  createClassroom,
  getMyClassrooms,
  getClassroom,
  updateClassroom,
  deleteClassroom,
  enrollStudent,
  leaveClassroom,
  getClassroomSessions,
  getEnrolledClassrooms,
  getRecordedClasses,
  getCollegeStudents,
  toggleBlockStudent,
  createClassroomValidation,
  enrollValidation,
  updateClassroomValidation,
  classroomIdParamValidation,
  studentIdParamValidation,
};
