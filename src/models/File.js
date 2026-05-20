'use strict';

const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Session',
      default: null,
      index: true,
    },
    college_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'User',
      required: true,
      index: true,
    },
    ownerRole: { type: String, enum: ['teacher', 'student'], required: true },

    // file type: notes | assignment | diagram | pdf | image | video
    fileType: { type: String, required: true, index: true },
    title: { type: String, default: 'Untitled' },
    mimeType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 }, // bytes
    url: { type: String, default: null }, // storage URL / path
    storageKey: { type: String, default: null }, // S3 key or local path

    // Canvas Persistence (Fabric.js JSON state)
    // Stores the entire session notes for multi-page reopening
    canvasData: { type: String, default: null },


    // Folder organisation (subject-wise folders)
    folderId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'Folder',
      default: null,
      index: true,
    },

    // For teacher broadcast files: everyone gets reference
    isBroadcast: { type: Boolean, default: false },

    // Auto-save tracking
    isAutoSaved: { type: Boolean, default: false },
    lastAutoSavedAt: { type: Date, default: null },

    // Soft delete
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

fileSchema.index({ college_id: 1, sessionId: 1, ownerRole: 1 });
fileSchema.index({ college_id: 1, ownerId: 1, fileType: 1, isDeleted: 1 });

// Force re-registration to bust Mongoose model cache
delete mongoose.models['File'];
delete mongoose.modelSchemas?.['File'];

module.exports = mongoose.model('File', fileSchema);
