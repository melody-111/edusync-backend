'use strict';

const mongoose = require('mongoose');

const terminalSessionSchema = new mongoose.Schema(
  {
    terminalId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    qrToken: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['pending', 'synced', 'expired'],
      default: 'pending',
    },
    targetRole: {
      type: String,
      enum: ['teacher', 'student'],
      required: true,
      default: 'student',
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    accessToken: {
      type: String,
      default: null,
    },
    refreshToken: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // TTL index
    },
    lastRefreshedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TerminalSession', terminalSessionSchema);
