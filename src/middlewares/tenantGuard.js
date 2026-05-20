'use strict';

const { sendError } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Ensures the user making the request has a valid college_id (tenant isolation).
 * Super admins can bypass this for tenant-agnostic operations.
 */
const tenantGuard = (req, res, next) => {
  if (!req.user) {
    return sendError(res, 'Unauthorized. Please login.', 401);
  }

  // Super admins don't strictly need a college_id for global operations
  if (req.user.role === 'super_admin') {
    return next();
  }

  if (!req.user.college_id) {
    logger.warn(`[TENANT_GUARD] User ${req.user._id} attempted access without a college_id`);
    return sendError(res, 'Tenant context missing. Contact administrator.', 403);
  }

  // Inject the tenantId into the request for easier access in controllers
  req.tenantId = req.user.college_id;
  
  next();
};

/**
 * Ensures the user has a specific role or higher.
 */
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return sendError(res, `Forbidden. Requires one of these roles: ${roles.join(', ')}`, 403);
    }
    next();
  };
};

module.exports = {
  tenantGuard,
  requireRole
};
