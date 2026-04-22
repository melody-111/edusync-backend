'use strict';

const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const { cache } = require('../config/redis');
const { sendError } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Core authentication middleware
 * Validates Bearer JWT, hydrates req.user
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 'Authorization token required', 401);
    }

    const token = authHeader.split(' ')[1];

    // ─── Dev Mode Bypass ──────────────────────────────────────────────────────
    if (token === 'dev_token_secret' || token === 'dev_teacher_secret') {
       const role = token === 'dev_token_secret' ? 'student' : 'teacher';
       const userId = token === 'dev_token_secret' ? 'dev_student_101' : 'dev_teacher_99';
       req.user = { 
          _id: userId, 
          name: 'Dev User', 
          role,
          isActive: true,
          classroomId: 'Class 1',
          branch: 'CS',
          year: '3rd',
          semester: '6'
       };
       req.tokenPayload = { sub: userId, role };
       return next();
    }

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') return sendError(res, 'Token expired', 401);
      return sendError(res, 'Invalid token', 401);
    }

    // Check token blacklist (logout / revocation)
    const blacklisted = await cache.exists(`blacklist:${decoded.jti}`);
    if (blacklisted) return sendError(res, 'Token has been revoked', 401);

    // Try user from cache first
    const cacheKey = `user:${decoded.sub}`;
    let user = await cache.getJSON(cacheKey);

    if (!user) {
      user = await User.findById(decoded.sub).lean();
      if (!user) return sendError(res, 'User not found', 401);
      await cache.setJSON(cacheKey, user, 300); // cache 5 min
    }

    if (!user.isActive) return sendError(res, 'Account is disabled', 403);

    req.user = user;
    req.tokenPayload = decoded;
    return next();
  } catch (err) {
    logger.error(`Auth middleware error: ${err.message}`);
    return sendError(res, 'Authentication failed', 500);
  }
};

/**
 * Require specific role(s)
 * Usage: requireRole('teacher') or requireRole(['teacher','student'])
 */
const requireRole = (...roles) => (req, res, next) => {
  const allowed = roles.flat();
  if (!req.user || !allowed.includes(req.user.role)) {
    return sendError(res, 'Access forbidden: insufficient role', 403);
  }
  return next();
};

/**
 * Optional auth — populates req.user if token is present, never fails
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub).lean();
    if (user && user.isActive) {
      req.user = user;
      req.tokenPayload = decoded;
    }
  } catch {
    // silently ignore
  }
  return next();
};

module.exports = { authenticate, requireRole, optionalAuth };
