'use strict';

const mongoose = require('mongoose');

const classroomSchema = new mongoose.Schema(
  {
    college_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    code: {
      type: String,
      unique: true,
      index: true,
      default: () => Math.random().toString(36).substring(2, 8).toUpperCase(),
    },
    students: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        joinedAt: { type: Date, default: new Date() },
        isActive: { type: Boolean, default: true },
        isBlocked: { type: Boolean, default: false }, // Teacher can block student
      },
    ],
    sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    isActive: { type: Boolean, default: true },
    maxStudents: { type: Number, default: 100 },
    subject: { type: String, default: '' },
    grade: { type: String, default: '' },
  },
  { timestamps: true }
);

classroomSchema.index({ college_id: 1, teacherId: 1, isActive: 1 });

module.exports = mongoose.model('Classroom', classroomSchema);
