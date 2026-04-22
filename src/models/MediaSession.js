'use strict';

const mongoose = require('mongoose');

const mediaSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // YouTube / video
    mediaType: {
      type: String,
      enum: ['youtube', 'local', 'stream'],
      default: 'youtube',
    },
    mediaUrl: { type: String, required: true },
    youtubeVideoId: { type: String, default: null },

    // State (latest known)
    state: {
      type: String,
      enum: ['idle', 'playing', 'paused', 'ended'],
      default: 'idle',
    },
    seekPositionSeconds: { type: Number, default: 0 },
    lastStateChangedAt: { type: Date, default: new Date() },
    lastStateChangedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Students cannot control — enforced at socket + API level
    allowStudentControl: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

mediaSessionSchema.index({ sessionId: 1, isActive: 1 });

module.exports = mongoose.model('MediaSession', mediaSessionSchema);
