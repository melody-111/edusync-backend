'use strict';

const mongoose = require('mongoose');

const examSubmissionSchema = new mongoose.Schema(
  {
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    studentName: {
      type: String,
      required: true,
    },
    studentEmail: {
      type: String,
      required: true,
    },
    rollNumber: {
      type: String,
      default: '',
    },
    className: {
      type: String,
      default: '',
    },
    section: {
      type: String,
      default: '',
    },
    canvasData: {
      type: String, // Full JSON serialization of the student's canvas answer sheet
      required: true,
    },
    answerImageUrl: {
      type: String, // Rendered PNG snapshot of the student's answer sheet
      default: '',
    },
    status: {
      type: String,
      enum: ['submitted', 'graded'],
      default: 'submitted',
    },
    marksObtained: {
      type: Number,
      default: null,
    },
    teacherFeedback: {
      type: String,
      default: '',
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    gradedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

examSubmissionSchema.index({ examId: 1, studentId: 1 }, { unique: true });

module.exports = mongoose.model('ExamSubmission', examSubmissionSchema);
