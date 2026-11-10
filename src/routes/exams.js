'use strict';

const express = require('express');
const router = express.Router();
const {
  createExam,
  getActiveExam,
  submitExam,
  getTeacherExams,
  getExamSubmissions,
  gradeSubmission,
  endExam,
} = require('../controllers/examController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Student & Teacher
router.get('/active', getActiveExam);

// Student
router.post('/:examId/submit', submitExam);

// Teacher
router.post('/start', createExam);
router.get('/teacher', getTeacherExams);
router.get('/:examId/submissions', getExamSubmissions);
router.post('/submissions/:submissionId/grade', gradeSubmission);
router.post('/:examId/end', endExam);

module.exports = router;
