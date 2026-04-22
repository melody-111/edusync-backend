'use strict';

const rateLimit = require('express-rate-limit');
const { sendError } = require('../utils/helpers');

/**
 * Creates a rate limiter instance with optimized defaults for production.
 * Supports Cloudflare IP headers automatically.
 */
const createLimiter = (windowMs, max, message) => {
  const isDev = process.env.NODE_ENV === 'development';
  
  return rateLimit({
    windowMs: isDev ? 1000 : windowMs, // 1 second in dev for easier testing
    max: isDev ? 1000 : max,           // High limit in dev
    standardHeaders: true,             // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,              // Disable `X-RateLimit-*` headers
    handler: (req, res) => {
      req.log?.warn?.(`Rate limit exceeded for IP: ${req.ip}`);
      return sendError(res, message, 429);
    },
    // Trust Cloudflare headers for the real client IP
    keyGenerator: (req) => {
      return (
        req.headers['cf-connecting-ip'] || 
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
        req.ip
      );
    },
    // Skip failed requests from counting against the rate limit (prevents DDoS from blocking valid users on errors)
    skipFailedRequests: false, 
    // Skip successful requests (optional: if you only want to limit brute-force/errors)
    skipSuccessfulRequests: false,
  });
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
  parseInt(process.env.RATE_LIMIT_MAX, 10) || 300, // Increased default for heavy real-time usage
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
