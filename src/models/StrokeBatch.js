'use strict';

const mongoose = require('mongoose');

/**
 * Strokes are stored in BATCHES (never per-stroke writes).
 * Each document = one batch of strokes for one page.
 */
const strokeBatchSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
      index: true,
    },
    pageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Page',
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    ownerRole: { type: String, enum: ['teacher', 'student'], required: true },

    /**
     * strokes: array of compressed stroke objects
     * Each stroke: { x, y, pressure, color, width, tool, timestamp }
     * Stored as JSON string (compressed) to minimize payload size
     */
    strokesData: {
      type: Buffer, // compressed JSON
      required: true,
    },
    strokeCount: { type: Number, default: 0 },
    batchIndex: { type: Number, default: 0 }, // ordering within page

    // Compression flag
    compressed: { type: Boolean, default: true },
  },
  { 
    timestamps: true,
    collection: 'strokes', // Strictly mapped to the user checklist
  }
);

strokeBatchSchema.index({ sessionId: 1, pageId: 1, ownerId: 1 });
strokeBatchSchema.index({ createdAt: 1 }); // for time-ordered replay

module.exports = mongoose.model('StrokeBatch', strokeBatchSchema);
