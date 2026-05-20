'use strict';

const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    college_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    deviceType: {
      type: String,
      enum: ['teacher-device', 'student-desk', 'mobile-device'],
      required: true,
    },
    deviceName: { type: String, default: 'Unknown Device' },
    platform: { type: String, default: null }, // ios, android, web, desktop
    userAgent: { type: String, default: null },
    lastIp: { type: String, default: null },

    // Session tracking
    activeSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      default: null,
    },
    status: {
      type: String,
      enum: ['online', 'offline', 'idle'],
      default: 'offline',
    },
    lastSeenAt: { type: Date, default: new Date() },
    lastConnectedAt: { type: Date, default: null },
    socketId: { type: String, default: null },

    // Push
    fcmToken: { type: String, default: null },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

deviceSchema.index({ college_id: 1, userId: 1, deviceType: 1 });
deviceSchema.index({ activeSessionId: 1 });

module.exports = mongoose.model('Device', deviceSchema);
