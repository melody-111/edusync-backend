'use strict';

const ActivityLog = require('../models/ActivityLog');
const logger = require('./logger');

/**
 * Log an activity asynchronously (non-blocking)
 */
const logActivity = (params) => {
  const {
    sessionId = null,
    userId = null,
    actorRole = 'system',
    action,
    category = 'system',
    details = null,
    ip = null,
    userAgent = null,
  } = params;

  // Fire and forget — never block the request
  ActivityLog.create({
    sessionId,
    userId,
    actorRole,
    action,
    category,
    details,
    ip,
    userAgent,
  }).catch((err) => logger.error(`ActivityLog write failed: ${err.message}`));
};

/**
 * Express middleware to auto-log HTTP requests at route level
 */
const auditMiddleware = (action, category = 'system') => (req, res, next) => {
  res.on('finish', () => {
    logActivity({
      sessionId: req.sessionDoc?._id || null,
      userId: req.user?._id || null,
      actorRole: req.user?.role || 'system',
      action,
      category,
      details: {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        body: req.method !== 'GET' ? sanitizeBody(req.body) : undefined,
      },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  });
  next();
};

const SENSITIVE_FIELDS = ['password', 'token', 'otp', 'secret', 'passwordHash'];

const sanitizeBody = (body) => {
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(
    Object.entries(body).map(([k, v]) => [
      k,
      SENSITIVE_FIELDS.includes(k.toLowerCase()) ? '[REDACTED]' : v,
    ])
  );
};

module.exports = { logActivity, auditMiddleware };
