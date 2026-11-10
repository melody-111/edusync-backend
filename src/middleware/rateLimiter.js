'use strict';

const rateLimit = require('express-rate-limit');
const { sendError } = require('../utils/helpers');

/**
 * Creates a rate limiter instance with optimized defaults for production.
 * Supports Cloudflare IP headers automatically.
 */
const createLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max: (req) => {
      // Allow generous headroom on localhost / loopback during developer testing & campus NAT
      const ip = req.ip || req.connection?.remoteAddress || '';
      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('localhost');
      if (isLoopback) return 500;
      return max;
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      sendError(res, message || 'Too many requests. Please try again later.', 429);
    }
  });
};

// Auth endpoints — Generous on IP to support campus Wi-Fi / NAT, while protected by Account-Level Lockout
const authLimiter = createLimiter(
  15 * 60 * 1000, // 15 min
  100, // 100 per 15 min per IP to prevent NAT starvation
  'Too many login attempts. Your IP has been temporarily blocked for 15 minutes.'
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
