'use strict';

const express = require('express');
const router = express.Router();

const {
  createClassroom,
  getMyClassrooms,
  getClassroom,
  updateClassroom,
  deleteClassroom,
  enrollStudent,
  leaveClassroom,
  getClassroomSessions,
  getEnrolledClassrooms,
  createClassroomValidation,
  enrollValidation,
  updateClassroomValidation,
  classroomIdParamValidation,
  getRecordedClasses,
} = require('../controllers/classroomController');

const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { apiLimiter } = require('../middleware/rateLimiter');

router.use(authenticate);
router.use(apiLimiter);

// Teacher routes
router.post('/', requireRole('teacher'), createClassroomValidation, validate, createClassroom);
router.get('/mine', requireRole('teacher'), getMyClassrooms);
router.put('/:id', requireRole('teacher'), updateClassroomValidation, validate, updateClassroom);
router.delete('/:id', requireRole('teacher'), classroomIdParamValidation, validate, deleteClassroom);
router.get('/:id/sessions', classroomIdParamValidation, validate, getClassroomSessions);

// Student routes
router.post('/enroll', requireRole('student'), enrollValidation, validate, enrollStudent);
router.post('/:id/leave', requireRole('student'), classroomIdParamValidation, validate, leaveClassroom);
router.get('/enrolled', requireRole('student'), getEnrolledClassrooms);

// Shared
router.get('/recordings', getRecordedClasses); // Note: must be before /:id so it doesn't match ID param
router.get('/:id', classroomIdParamValidation, validate, getClassroom);

module.exports = router;
