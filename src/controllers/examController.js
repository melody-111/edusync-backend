'use strict';

const Exam = require('../models/Exam');
const ExamSubmission = require('../models/ExamSubmission');
const User = require('../models/User');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');
const { getSocketServer } = require('../socket/server');
const { logActivity } = require('../utils/activityLogger');

/**
 * ─── Teacher: Create & Start Exam ───────────────────────────────────────────
 */
const createExam = asyncHandler(async (req, res) => {
  const user = req.user;
  if (user.role !== 'teacher') {
    return sendError(res, 'Only teachers can start an exam', 403);
  }

  const {
    title,
    subject,
    className,
    section,
    branch,
    year,
    semester,
    institutionType,
    pdfUrl,
    pdfTitle,
    durationMinutes,
    totalMarks,
  } = req.body;

  if (!title || !subject || !className || !section || !pdfUrl) {
    return sendError(res, 'Missing required fields (title, subject, className, section, pdfUrl)', 400);
  }

  const exam = await Exam.create({
    teacherId: user._id,
    teacherName: user.name,
    collegeId: user.college_id || null,
    title: title.trim(),
    subject: subject.trim(),
    className: className.trim(),
    section: section.trim(),
    branch: branch?.trim() || '',
    year: year?.trim() || '',
    semester: semester?.trim() || '',
    institutionType: institutionType || user.institutionType || 'school',
    pdfUrl,
    pdfTitle: pdfTitle || 'Question Paper.pdf',
    durationMinutes: Number(durationMinutes) || 60,
    totalMarks: Number(totalMarks) || 100,
    status: 'active',
    startedAt: new Date(),
  });

  // Real-time broadcast to all connected students
  const _io = getSocketServer();
  if (_io) {
    _io.emit('exam:started', {
      examId: exam._id,
      title: exam.title,
      subject: exam.subject,
      className: exam.className,
      section: exam.section,
      branch: exam.branch,
      year: exam.year,
      semester: exam.semester,
      institutionType: exam.institutionType,
      pdfUrl: exam.pdfUrl,
      pdfTitle: exam.pdfTitle,
      durationMinutes: exam.durationMinutes,
      totalMarks: exam.totalMarks,
      teacherName: exam.teacherName,
      startedAt: exam.startedAt,
    });
  }

  logActivity({
    userId: user._id,
    actorRole: 'teacher',
    action: 'exam.start',
    category: 'exam',
    details: { examId: exam._id, title: exam.title, className: exam.className, section: exam.section },
  });

  return sendSuccess(res, { exam }, 'Exam started successfully', 201);
});

/**
 * ─── Student: Get Active Exam for My Class & Section ────────────────────────
 */
const getActiveExam = asyncHandler(async (req, res) => {
  const user = req.user;

  // Find active exam matching student's class and section
  const query = {
    status: 'active',
  };

  if (user.role === 'student') {
    if (user.institutionType === 'school') {
      if (user.className) query.className = user.className;
      if (user.section) query.section = user.section;
    } else {
      if (user.course) query.className = user.course;
      if (user.branch) query.branch = user.branch;
    }
  }

  const exam = await Exam.findOne(query).sort({ createdAt: -1 }).lean();
  if (!exam) {
    return sendSuccess(res, { exam: null, hasSubmitted: false });
  }

  // Check if student has already submitted
  let submission = null;
  if (user.role === 'student') {
    submission = await ExamSubmission.findOne({
      examId: exam._id,
      studentId: user._id,
    }).lean();
  }

  return sendSuccess(res, {
    exam,
    hasSubmitted: Boolean(submission),
    submission,
  });
});

/**
 * ─── Student: Submit Exam Answer Paper ──────────────────────────────────────
 * Note: Saves strictly to ExamSubmission; NOT saved into student's personal notes library.
 */
const submitExam = asyncHandler(async (req, res) => {
  const user = req.user;
  if (user.role !== 'student') {
    return sendError(res, 'Only students can submit exam papers', 403);
  }

  const { examId } = req.params;
  const { canvasData, answerImageUrl } = req.body;

  if (!canvasData) {
    return sendError(res, 'Answer sheet canvas data is required', 400);
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    return sendError(res, 'Exam not found', 404);
  }

  const submission = await ExamSubmission.findOneAndUpdate(
    { examId: exam._id, studentId: user._id },
    {
      studentName: user.name,
      studentEmail: user.email,
      rollNumber: user.rollNumber || user.idNumber || '',
      className: user.className || user.course || exam.className,
      section: user.section || exam.section,
      canvasData: typeof canvasData === 'string' ? canvasData : JSON.stringify(canvasData),
      answerImageUrl: answerImageUrl || '',
      status: 'submitted',
      submittedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Notify teacher via Socket.io
  const _io = getSocketServer();
  if (_io) {
    _io.to(exam.teacherId.toString()).emit('exam:submission:received', {
      examId: exam._id,
      submissionId: submission._id,
      studentId: user._id,
      studentName: user.name,
      rollNumber: submission.rollNumber,
      submittedAt: submission.submittedAt,
    });
  }

  logActivity({
    userId: user._id,
    actorRole: 'student',
    action: 'exam.submit',
    category: 'exam',
    details: { examId: exam._id, submissionId: submission._id },
  });

  return sendSuccess(res, { submission }, 'Exam paper submitted successfully to teacher');
});

/**
 * ─── Teacher: Get Exams with Class / Section Folder Hierarchy ───────────────
 */
const getTeacherExams = asyncHandler(async (req, res) => {
  const user = req.user;
  if (user.role !== 'teacher') {
    return sendError(res, 'Access denied', 403);
  }

  const exams = await Exam.find({ teacherId: user._id })
    .sort({ createdAt: -1 })
    .lean();

  // Attach submission counts
  const examIds = exams.map((e) => e._id);
  const submissions = await ExamSubmission.find({ examId: { $in: examIds } })
    .select('examId studentName rollNumber status submittedAt marksObtained')
    .lean();

  const countMap = {};
  submissions.forEach((s) => {
    const k = s.examId.toString();
    if (!countMap[k]) countMap[k] = [];
    countMap[k].push(s);
  });

  const enrichedExams = exams.map((e) => ({
    ...e,
    submissionsCount: countMap[e._id.toString()]?.length || 0,
    submissions: countMap[e._id.toString()] || [],
  }));

  // Structure by ClassName -> Section -> Exams
  const folderTree = {};
  enrichedExams.forEach((e) => {
    const cName = e.className || 'General';
    const sName = e.section || 'All';
    if (!folderTree[cName]) folderTree[cName] = {};
    if (!folderTree[cName][sName]) folderTree[cName][sName] = [];
    folderTree[cName][sName].push(e);
  });

  return sendSuccess(res, {
    exams: enrichedExams,
    folderTree,
  });
});

/**
 * ─── Teacher: Get Submissions for an Exam ────────────────────────────────────
 */
const getExamSubmissions = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const user = req.user;

  const exam = await Exam.findById(examId).lean();
  if (!exam) return sendError(res, 'Exam not found', 404);

  if (exam.teacherId.toString() !== user._id.toString() && user.role !== 'admin') {
    return sendError(res, 'Access denied to this exam', 403);
  }

  const submissions = await ExamSubmission.find({ examId })
    .sort({ submittedAt: -1 })
    .lean();

  return sendSuccess(res, { exam, submissions });
});

/**
 * ─── Teacher: Grade / Review a Student's Submission ─────────────────────────
 */
const gradeSubmission = asyncHandler(async (req, res) => {
  const { submissionId } = req.params;
  const { marksObtained, teacherFeedback } = req.body;
  const user = req.user;

  if (user.role !== 'teacher') {
    return sendError(res, 'Only teachers can grade papers', 403);
  }

  const submission = await ExamSubmission.findById(submissionId);
  if (!submission) return sendError(res, 'Submission not found', 404);

  submission.marksObtained = Number(marksObtained);
  submission.teacherFeedback = teacherFeedback || '';
  submission.status = 'graded';
  submission.gradedAt = new Date();
  await submission.save();

  return sendSuccess(res, { submission }, 'Evaluation saved successfully');
});

/**
 * ─── Teacher: End Exam ──────────────────────────────────────────────────────
 */
const endExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const user = req.user;

  const exam = await Exam.findOne({ _id: examId, teacherId: user._id });
  if (!exam) return sendError(res, 'Exam not found', 404);

  exam.status = 'ended';
  exam.endedAt = new Date();
  await exam.save();

  const _io = getSocketServer();
  if (_io) {
    _io.emit('exam:ended', { examId: exam._id });
  }

  return sendSuccess(res, { exam }, 'Exam ended successfully');
});

module.exports = {
  createExam,
  getActiveExam,
  submitExam,
  getTeacherExams,
  getExamSubmissions,
  gradeSubmission,
  endExam,
};
