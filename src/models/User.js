'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    avatar: { type: String, default: null },
    college_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      index: true,
      // Not strictly required for super_admin, but required for others
    },
    role: {
      type: String,
      enum: ['teacher', 'student', 'super_admin'],
      required: true,
      index: true,
    },

    // Auth methods
    authProviders: {
      google: {
        googleId: { type: String, default: null },
      },
      local: {
        passwordHash: { type: String, default: null },
        otpSecret: { type: String, default: null },
        otpExpiry: { type: Date, default: null },
        lastOtpSentAt: { type: Date, default: null },
      },
    },
    cloudStorageUsed: {
      type: Number,
      default: 0,
    },

    // Tokens
    refreshToken: { type: String, default: null, select: false },

    // Status
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: null },

    // AI usage tracking
    aiUsageToday: { type: Number, default: 0 },
    aiUsageResetAt: { type: Date, default: new Date() },

    // Academic Profile (Added for Mobile App)
    rollNumber: { type: String, trim: true, default: null },
    semester: { type: String, trim: true, default: null },
    year: { type: String, trim: true, default: null },
    branch: { type: String, trim: true, default: null },
    course: { type: String, trim: true, default: null },
    gmail: { type: String, trim: true, default: null },
    className: { type: String, trim: true, default: null }, // Added for school students
    idNumber: { type: String, trim: true, default: null }, // Employee ID or Staff Number
    institutionName: { type: String, trim: true, default: null },
    institutionType: { type: String, enum: ['school', 'college', 'university'], default: 'university' },
    section: { type: String, trim: true, default: null },
    subjectId: { type: String, trim: true, default: null }, // For teachers
    subjectName: { type: String, trim: true, default: null }, // For teachers
    teacherCode: { type: String, unique: true, sparse: true, trim: true }, // Unique code for students to join
    // QR Login Token (for scanning-to-login feature)
    qrLoginToken: { type: String, unique: true, sparse: true, select: false },
    lastQrRefreshAt: { type: Date, default: null },

    // Push notification tokens
    fcmTokens: [{ type: String }],

    // Classroom Identification
    deskId: { type: String, trim: true, sparse: true, index: true }, // Teacher's Desk ID
    classroomId: { type: String, trim: true, index: true }, // Student's assigned classroom
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_, ret) => {
        delete ret.__v;
        delete ret.refreshToken;
        if (ret.authProviders?.local) delete ret.authProviders.local.passwordHash;
        return ret;
      },
    },
  }
);

// ─── Instance Methods ─────────────────────────────────────────────────────────
userSchema.methods.setPassword = async function (password) {
  this.authProviders.local.passwordHash = await bcrypt.hash(password, 10);
};

userSchema.methods.verifyPassword = async function (password) {
  if (!this.authProviders?.local?.passwordHash) return false;
  return bcrypt.compare(password, this.authProviders.local.passwordHash);
};

userSchema.methods.toSafeObject = function () {
  return {
    _id: this._id,
    email: this.email,
    name: this.name,
    avatar: this.avatar,
    role: this.role,
    college_id: this.college_id,
    institutionName: this.institutionName,
    institutionType: this.institutionType,
    rollNumber: this.rollNumber,
    semester: this.semester,
    year: this.year,
    branch: this.branch,
    course: this.course,
    className: this.className,
    idNumber: this.idNumber,
    subjectName: this.subjectName,
    deskId: this.deskId,
    classroomId: this.classroomId,
    teacherCode: this.teacherCode,
    isVerified: this.isVerified,
    isActive: this.isActive,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
  };
};

// ─── Indexes ──────────────────────────────────────────────────────────────────
userSchema.index({ 'authProviders.google.googleId': 1 }, { sparse: true });
userSchema.index({ email: 1, role: 1 });

module.exports = mongoose.model('User', userSchema);
