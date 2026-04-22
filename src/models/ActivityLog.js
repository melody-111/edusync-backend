'use strict';

const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    actorRole: { type: String, enum: ['teacher', 'student', 'system'], default: 'system' },

    action: {
      type: String,
      required: true,
      index: true,
      // e.g. session.start, session.end, student.join, student.leave,
      //      control.update, file.upload, ai.request, auth.login, etc.
    },

    category: {
      type: String,
      enum: ['auth', 'session', 'canvas', 'file', 'control', 'ai', 'media', 'system'],
      default: 'system',
    },

    details: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },

    // For compliance / GDPR — mark logs for deletion
    retainUntil: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
    },
  },
  {
    timestamps: true,
    // Capped collection is an option for very high throughput logs
  }
);

activityLogSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });
activityLogSchema.index({ sessionId: 1, action: 1 });
activityLogSchema.index({ userId: 1, category: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
