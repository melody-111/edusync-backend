'use strict';

const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Session',
      required: true,
      index: true,
    },
    fileId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'File',
      default: null,
    },
    ownerId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'User',
      required: true,
    },
    ownerRole: { type: String, enum: ['teacher', 'student'], required: true },

    pageNumber: { type: Number, required: true, min: 1 },
    title: { type: String, default: '' },

    // Canvas background (whiteboard, pdf overlay, image)
    backgroundType: {
      type: String,
      enum: ['blank', 'pdf', 'image', 'grid', 'lines'],
      default: 'blank',
    },
    backgroundUrl: { type: String, default: null },

    // Snapshot of final canvas (base64 or URL) for PDF generation
    canvasSnapshot: { type: String, default: null },
    snapshotUpdatedAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

pageSchema.index({ sessionId: 1, ownerId: 1, pageNumber: 1 }, { unique: true });

module.exports = mongoose.model('Page', pageSchema);
