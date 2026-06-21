'use strict';

const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    parentFolder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Folder',
      default: null
    },
    ownerId: {
      type: mongoose.Schema.Types.Mixed,
      ref: 'User',
      required: true,
      index: true
    },
    ownerRole: {
      type: String,
      enum: ['student', 'teacher'],
      required: true
    },
    subject: {
      type: String,
      trim: true,
      default: 'General'
    },
    folderType: {
      type: String,
      enum: ['notes', 'assignments', 'experiments', 'other'],
      default: 'notes'
    },
    color: {
      type: String,
      default: '#6c63ff'
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Prevent same name in same parent
folderSchema.index({ name: 1, parentFolder: 1, ownerId: 1 }, { unique: true });

// Force re-registration to bust Mongoose model cache
delete mongoose.models['Folder'];
delete mongoose.modelSchemas?.['Folder'];

module.exports = mongoose.model('Folder', folderSchema);
