'use strict';

const mongoose = require('mongoose');

const syncQueueSchema = new mongoose.Schema(
  {
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
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      default: null,
    },

    // Operation type
    operation: {
      type: String,
      enum: ['stroke_batch', 'note_update', 'page_create', 'file_upload', 'canvas_snapshot'],
      required: true,
    },

    // Payload stored as JSON string
    payload: { type: String, required: true },

    // Sync status
    status: {
      type: String,
      enum: ['pending', 'processing', 'synced', 'failed'],
      default: 'pending',
      index: true,
    },
    retryCount: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 5 },
    lastAttemptAt: { type: Date, default: null },
    syncedAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },

    // Client-side timestamp (when operation happened offline)
    clientTimestamp: { type: Date, required: true },

    // Sequence number for ordering
    sequence: { type: Number, default: 0 },
  },
  { timestamps: true }
);

syncQueueSchema.index({ userId: 1, status: 1, sequence: 1 });
syncQueueSchema.index({ sessionId: 1, status: 1 });

module.exports = mongoose.model('SyncQueue', syncQueueSchema);
