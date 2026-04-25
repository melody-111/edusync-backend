'use strict';

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const { body, validationResult, param } = require('express-validator');
const logger = require('../utils/logger');

// ─── Rate Limiting Configuration ───────────────────────────────────────────────

// General API rate limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/ready';
  },
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, path: ${req.path}`);
    res.status(429).json({
      success: false,
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: Math.ceil(15 * 60)
    });
  }
});

// Strict rate limiter for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false,
  handler: (req, res) => {
    logger.warn(`Auth rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many authentication attempts, please try again later.',
      retryAfter: Math.ceil(15 * 60)
    });
  }
});

// Strict rate limiter for OTP endpoints
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Limit each IP to 3 OTP requests per hour
  message: 'Too many OTP requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`OTP rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many OTP requests, please try again later.',
      retryAfter: Math.ceil(60 * 60)
    });
  }
});

// ─── Input Validation ───────────────────────────────────────────────────────────

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn(`Validation failed: ${JSON.stringify(errors.array())}`);
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// Common validation rules
const emailValidation = body('email')
  .trim()
  .isEmail()
  .normalizeEmail()
  .withMessage('Please provide a valid email address');

const passwordValidation = body('password')
  .isLength({ min: 8 })
  .withMessage('Password must be at least 8 characters long')
  .matches(/[A-Z]/)
  .withMessage('Password must contain at least one uppercase letter')
  .matches(/[a-z]/)
  .withMessage('Password must contain at least one lowercase letter')
  .matches(/[0-9]/)
  .withMessage('Password must contain at least one number');

const mongoIdValidation = param('id')
  .isMongoId()
  .withMessage('Invalid ID format');

const uuidValidation = param('id')
  .isUUID()
  .withMessage('Invalid UUID format');

// ─── Security Headers Configuration ───────────────────────────────────────────────

const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
});

// ─── Request ID Middleware ───────────────────────────────────────────────────────

const requestId = (req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
};

// ─── Security Logging ─────────────────────────────────────────────────────────────

const logSecurityEvent = (event, details) => {
  logger.warn(`Security Event: ${event}`, details);
};

// ─── IP Whitelist/Blacklist Middleware ───────────────────────────────────────────

const ipWhitelist = (allowedIPs) => {
  return (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    if (!allowedIPs.includes(clientIP)) {
      logSecurityEvent('IP_NOT_WHITELISTED', { ip: clientIP });
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    next();
  };
};

const ipBlacklist = (blockedIPs) => {
  return (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    if (blockedIPs.includes(clientIP)) {
      logSecurityEvent('IP_BLACKLISTED', { ip: clientIP });
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    next();
  };
};

// ─── Request Size Limiting ───────────────────────────────────────────────────────

const requestSizeLimit = (maxSize = '10mb') => {
  return (req, res, next) => {
    const contentLength = req.get('content-length');
    const maxSizeBytes = parseInt(maxSize) * 1024 * 1024;
    
    if (contentLength > maxSizeBytes) {
      logSecurityEvent('REQUEST_TOO_LARGE', { 
        size: contentLength, 
        maxSize: maxSizeBytes 
      });
      return res.status(413).json({
        success: false,
        message: 'Request entity too large'
      });
    }
    next();
  };
};

// ─── SQL Injection Prevention ─────────────────────────────────────────────────────

const sanitizeSQLInput = (input) => {
  if (typeof input !== 'string') return input;
  return input.replace(/['";\\]/g, '');
};

// ─── XSS Prevention ─────────────────────────────────────────────────────────────

const sanitizeXSSInput = (input) => {
  if (typeof input !== 'string') return input;
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
};

module.exports = {
  generalLimiter,
  authLimiter,
  otpLimiter,
  validateRequest,
  emailValidation,
  passwordValidation,
  mongoIdValidation,
  uuidValidation,
  securityHeaders,
  requestId,
  logSecurityEvent,
  ipWhitelist,
  ipBlacklist,
  requestSizeLimit,
  sanitizeSQLInput,
  sanitizeXSSInput
};
