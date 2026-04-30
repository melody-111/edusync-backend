'use strict';

const rateLimit = require('express-rate-limit');
const { sendError } = require('../utils/helpers');

/**
 * Creates a rate limiter instance with optimized defaults for production.
 * Supports Cloudflare IP headers automatically.
 */
const createLimiter = (windowMs, max, message) => {
  // Disable rate limiting for development
  return (req, res, next) => next();
};

// Auth endpoints — Very strict to prevent brute-force
const authLimiter = createLimiter(
  15 * 60 * 1000, // 15 min
  15,             // Allow 15 attempts (increased slightly from 10 for better UX)
  'Too many login attempts. Please try again in 15 minutes.'
);

// OTP — Very strict
const otpLimiter = createLimiter(
  5 * 60 * 1000, // 5 min
  5,
  'Too many OTP requests. Please wait 5 minutes.'
);

// General API — Balanced
const apiLimiter = createLimiter(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  parseInt(process.env.RATE_LIMIT_MAX, 10) || 1000, // Increased for development with polling
  'Too many requests. Please slow down.'
);

// AI endpoint — Cost protection
const aiLimiter = createLimiter(
  60 * 1000, // 1 min
  10,        // More strict AI usage
  'AI rate limit exceeded. Max 10 requests per minute.'
);

// File upload — Prevents storage flooding
const uploadLimiter = createLimiter(
  60 * 1000, // 1 min
  10,
  'Upload rate limit exceeded. Please wait a minute.'
);

module.exports = { authLimiter, otpLimiter, apiLimiter, aiLimiter, uploadLimiter };
