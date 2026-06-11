'use strict';

const mongoose = require('mongoose');

const collegeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    collegeCode: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      uppercase: true,
      trim: true,
    },
    domain: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
    },
    country: {
      type: String,
      default: 'India',
      trim: true,
      index: true,
    },
    logo_url: {
      type: String,
      default: null,
    },
    address: {
      type: String,
      default: null,
    },
    contact_email: {
      type: String,
      trim: true,
    },
    contact_phone: {
      type: String,
      trim: true,
    },
    subscription_plan: {
      type: String,
      enum: ['trial', 'basic', 'pro', 'enterprise'],
      default: 'trial',
    },
    subscriptionStatus: {
      type: String,
      default: 'active',
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'inactive'],
      default: 'active',
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    max_students: {
      type: Number,
      default: 500,
    },
    max_teachers: {
      type: Number,
      default: 50,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('College', collegeSchema);
