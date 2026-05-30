'use strict';

const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const College = require('../models/College');
const { cache } = require('../config/redis');
const { sendError } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Core authentication middleware
 * Validates Bearer JWT, hydrates req.user
 */
const authenticate = async (req, res, next) => {
  try {
    // ─── Admin Key Bypass for Server / Website Calls ─────────────────────────
    const apiKey = req.headers['x-api-key'] || req.headers['x-admin-secret'];
    const adminSecret = process.env.ADMIN_SECRET || 'EDUSYNC_ADMIN_2024';
    const authHeader = req.headers.authorization;
    if (apiKey === adminSecret || (authHeader && (authHeader === `Bearer ${adminSecret}` || authHeader === adminSecret))) {
       req.user = { 
          _id: 'super_admin_101', 
          name: 'EduSync Super Admin', 
          email: process.env.ADMIN_EMAIL || 'sudhanshu@edusync.com',
          role: 'super_admin',
          isActive: true
       };
       req.tokenPayload = { sub: 'super_admin_101', role: 'super_admin' };
       return next();
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendError(res, 'Authorization token required', 401);
    }

    const token = authHeader.split(' ')[1];


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

    // Check college status
    if (user.college_id || user.institutionName) {
      const colQuery = user.college_id ? { _id: user.college_id } : { name: user.institutionName };
      const college = await College.findOne(colQuery).lean();
      if (college && (!college.isActive || college.status === 'suspended')) {
        return sendError(res, `Your institution (${college.name}) account has been suspended by the administrator. Please contact school administration.`, 403);
      }
    }

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
