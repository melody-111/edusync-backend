'use strict';

const mongoose = require('mongoose');

const appControlsSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
      unique: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Controls (teacher sets, students obey)
    keyboardEnabled: { type: Boolean, default: false },
    copyPasteEnabled: { type: Boolean, default: false },
    aiEnabled: { type: Boolean, default: false },
    youtubeEnabled: { type: Boolean, default: true },

    // Per-student overrides (map: userId -> override object)
    studentOverrides: {
      type: Map,
      of: new mongoose.Schema(
        {
          keyboardEnabled: Boolean,
          copyPasteEnabled: Boolean,
          aiEnabled: Boolean,
          youtubeEnabled: Boolean, // Added per-student YouTube override
        },
        { _id: false }
      ),
      default: new Map(),
    },

    // Audit log of control changes
    changeLog: [
      {
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        field: String,
        oldValue: mongoose.Schema.Types.Mixed,
        newValue: mongoose.Schema.Types.Mixed,
        changedAt: { type: Date, default: new Date() },
      },
    ],

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppControls', appControlsSchema);
