'use strict';

const mongoose = require('mongoose');

const exportedFileSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    exportType: {
      type: String,
      enum: ['session_pdf', 'student_notes_pdf', 'teacher_notes_pdf', 'combined_pdf'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'generating', 'done', 'failed'],
      default: 'pending',
      index: true,
    },
    fileUrl: { type: String, default: null },
    storagePath: { type: String, default: null },
    fileSizeBytes: { type: Number, default: 0 },
    generatedAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },

    // Email delivery
    sentToEmail: { type: String, default: null },
    emailSentAt: { type: Date, default: null },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    },
  },
  { timestamps: true }
);

exportedFileSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

module.exports = mongoose.model('ExportedFile', exportedFileSchema);
