'use strict';

const mongoose = require('mongoose');

const subjectSchema = new mongoose.Schema(
  {
    college_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Prevent cross-tenant subject duplicates
subjectSchema.index({ college_id: 1, code: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Subject', subjectSchema);
