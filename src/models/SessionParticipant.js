'use strict';

const mongoose = require('mongoose');

const sessionParticipantSchema = new mongoose.Schema(
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
    deviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Device',
      default: null,
    },
    role: { type: String, enum: ['teacher', 'student'], required: true },
    socketId: { type: String, default: null },
    joinedAt: { type: Date, default: new Date() },
    leftAt: { type: Date, default: null },
    isConnected: { type: Boolean, default: true },

    // For 80/20 — student own notes reference
    personalNotesFileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
      default: null,
    },

    // Reconnect tracking
    reconnectCount: { type: Number, default: 0 },
    lastHeartbeatAt: { type: Date, default: new Date() },
  },
  { timestamps: true }
);

sessionParticipantSchema.index({ sessionId: 1, userId: 1 }, { unique: true });
sessionParticipantSchema.index({ sessionId: 1, isConnected: 1 });

module.exports = mongoose.model('SessionParticipant', sessionParticipantSchema);
