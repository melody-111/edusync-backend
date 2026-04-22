'use strict';

const logger = require('../utils/logger');
const { logSecurityEvent } = require('./security');

/**
 * Global error handler — must be registered LAST in Express
 */
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal Server Error';
  let errorType = err.name || 'Error';
  let details = {};

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    statusCode = 422;
    message = 'Validation failed';
    details.errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message
    }));
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `Duplicate value for ${field}`;
    details.field = field;
    details.value = err.keyValue ? err.keyValue[field] : null;
  }

  // Mongoose CastError (invalid ObjectId)
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${err.path}`;
    details.field = err.path;
    details.value = err.value;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') { 
    statusCode = 401; 
    message = 'Invalid token';
    errorType = 'AuthenticationError';
    logSecurityEvent('INVALID_JWT', { ip: req.ip, path: req.path });
  }
  if (err.name === 'TokenExpiredError') { 
    statusCode = 401; 
    message = 'Token expired';
    errorType = 'AuthenticationError';
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') { 
    statusCode = 413; 
    message = 'File too large';
    errorType = 'FileSizeError';
    details.maxSize = '10MB';
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    statusCode = 400;
    message = 'Unexpected file field';
    errorType = 'FileUploadError';
  }

  // Redis errors
  if (err.name === 'ReplyError' && err.message.includes('READONLY')) {
    statusCode = 503;
    message = 'Service unavailable - Redis in read-only mode';
    errorType = 'ServiceUnavailableError';
  }

  // PostgreSQL errors
  if (err.code && err.code.startsWith('23')) {
    statusCode = 409;
    message = 'Database constraint violation';
    errorType = 'DatabaseError';
    details.code = err.code;
  }

  // Network errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    statusCode = 503;
    message = 'Service temporarily unavailable';
    errorType = 'NetworkError';
    details.code = err.code;
  }

  // Rate limit errors
  if (err.name === 'RateLimitError') {
    statusCode = 429;
    message = 'Too many requests';
    errorType = 'RateLimitError';
    details.retryAfter = err.retryAfter || 60;
  }

  // Log errors based on severity
  if (statusCode >= 500) {
    logger.error(`[${req.method}] ${req.originalUrl} — ${statusCode}: ${message}`, {
      stack: err.stack,
      body: req.body,
      query: req.query,
      params: req.params,
      errorType,
      details,
    });
  } else if (statusCode >= 400) {
    logger.warn(`[${req.method}] ${req.originalUrl} — ${statusCode}: ${message}`, {
      errorType,
      details,
    });
  }

  // Send error response
  const response = {
    success: false,
    message,
    errorType,
    ...(Object.keys(details).length > 0 && { details }),
    timestamp: new Date().toISOString(),
    path: req.originalUrl,
    method: req.method,
  };

  // Include stack trace in development
  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  return res.status(statusCode).json(response);
};

/**
 * 404 handler — catches undefined routes
 */
const notFoundHandler = (req, res) => {
  logger.warn(`Route not found: [${req.method}] ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  
  res.status(404).json({
    success: false,
    message: `Route not found: [${req.method}] ${req.originalUrl}`,
    errorType: 'NotFoundError',
    timestamp: new Date().toISOString(),
    path: req.originalUrl,
    method: req.method,
  });
};

/**
 * Async error wrapper for route handlers
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = { errorHandler, notFoundHandler, asyncHandler };
