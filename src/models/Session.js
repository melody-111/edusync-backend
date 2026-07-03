'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const sessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      default: uuidv4,
      unique: true,
      index: true,
    },
    college_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      required: false,
      index: true,
    },
    roomId: {
      type: String,
      default: () => `room_${uuidv4()}`,
      unique: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false, // Optional for self-study
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sessionType: {
      type: String,
      enum: ['class', 'self', 'free_study'],
      default: 'class',
      index: true,
    },
    teacherDeviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Device',
      default: null,
    },
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Classroom',
      default: null,
    },
    title: { type: String, default: 'Untitled Session' },
    subject: { type: String, default: 'General' },
    description: { type: String, default: '' },
    branch: { type: String, default: null },
    year: { type: String, default: null },
    semester: { type: String, default: null },
    className: { type: String, default: null },
    section: { type: String, default: null },

    // Library Integration
    folderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: null },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },


    // Status lifecycle: pending → active → ended → archived
    status: {
      type: String,
      enum: ['pending', 'active', 'ended', 'archived'],
      default: 'active',
      index: true,
    },

    // QR system
    qrToken: { type: String, required: true, select: false },
    qrCodeDataUrl: { type: String, default: null },
    qrExpiresAt: { type: Date, default: null }, // null = valid until session ends

    // Timing
    startedAt: { type: Date, default: new Date() },
    endedAt: { type: Date, default: null },
    scheduledEndAt: { type: Date, default: null },

    // Controls snapshot
    appControls: {
      keyboardEnabled: { type: Boolean, default: false },
      copyPasteEnabled: { type: Boolean, default: false },
      aiEnabled: { type: Boolean, default: false },
      youtubeEnabled: { type: Boolean, default: false },
    },
    // View state
    activeView: { type: String, enum: ['canvas', 'youtube'], default: 'canvas' },
    activeYouTubeVideoId: { type: String, default: null },
    // Screen layout config (e.g., 80% student writing area, 20% teacher preview)
    layoutConfig: {
      studentWritingRatio: { type: Number, default: 0.8 },
      teacherPreviewRatio: { type: Number, default: 0.2 },
      mode: { type: String, enum: ['standard', '8020', 'custom'], default: '8020' },
    },

    // Participant count
    participantCount: { type: Number, default: 0 },
    peakParticipantCount: { type: Number, default: 0 },

    // Export
    exportedPdfUrl: { type: String, default: null },
    exportStatus: {
      type: String,
      enum: ['none', 'pending', 'done', 'failed'],
      default: 'none',
    },

    // Save pipeline
    saveCompleted: { type: Boolean, default: false },
    savedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

sessionSchema.index({ college_id: 1, status: 1, startedAt: -1 });
sessionSchema.index({ college_id: 1, teacherId: 1, status: 1 });
sessionSchema.index({ college_id: 1, ownerId: 1, status: 1 });

module.exports = mongoose.model('Session', sessionSchema);
