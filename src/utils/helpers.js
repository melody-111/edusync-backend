'use strict';

/**
 * Wrapper for async route handlers — eliminates try/catch boilerplate
 * @param {Function} fn - async express handler
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Standard API success response
 */
const sendSuccess = (res, data = null, message = 'Success', statusCode = 200) => {
  const payload = { success: true, message };
  if (data !== null) payload.data = data;
  return res.status(statusCode).json(payload);
};

/**
 * Standard API error response
 */
const sendError = (res, message = 'An error occurred', statusCode = 500, errors = null) => {
  const payload = { success: false, message };
  if (errors) payload.errors = errors;
  return res.status(statusCode).json(payload);
};

/**
 * Paginate a mongoose query result
 */
const paginate = async (Model, query, options = {}) => {
  const { page = 1, limit = 20, sort = { createdAt: -1 }, populate = null, select = null } = options;
  const skip = (page - 1) * limit;

  let q = Model.find(query).sort(sort).skip(skip).limit(limit);
  if (populate) q = q.populate(populate);
  if (select) q = q.select(select);

  const [docs, total] = await Promise.all([q.exec(), Model.countDocuments(query)]);

  return {
    docs,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};

/**
 * Extract client IP accounting for proxies
 */
const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.headers['x-real-ip'] ||
  req.socket?.remoteAddress ||
  '127.0.0.1';

/**
 * Escape regular expression special characters to prevent ReDoS attacks
 * Clamps maximum length to 128 characters to prevent catastrophic evaluation.
 */
const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  const truncated = str.slice(0, 128);
  return truncated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Escape HTML special characters for email/template safety
 */
const escapeHtml = (str) => {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

/**
 * Remove sensitive credentials from user objects before returning in API responses
 */
const sanitizeUser = (user) => {
  if (!user) return null;
  const obj = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  delete obj.password;
  delete obj.hash;
  delete obj.salt;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  delete obj.otpHash;
  delete obj.qrToken;
  return obj;
};

module.exports = {
  asyncHandler,
  sendSuccess,
  sendError,
  paginate,
  getClientIp,
  escapeRegex,
  escapeHtml,
  sanitizeUser,
};
