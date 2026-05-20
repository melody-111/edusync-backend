'use strict';

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    college_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      required: true,
      index: true,
    },
    plan_name: {
      type: String,
      enum: ['trial', 'basic', 'pro', 'enterprise'],
      required: true,
    },
    start_date: {
      type: Date,
      required: true,
    },
    end_date: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'cancelled'],
      default: 'active',
    },
    billing_cycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      default: 'yearly',
    },
    amount_paid: {
      type: Number,
      default: 0,
    },
    transaction_id: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Subscription', subscriptionSchema);
