'use strict';

const logger = require('../utils/logger');

/**
 * Server-Side Template Injection (SSTI) & Code Injection Detector
 * Inspects all incoming request bodies, queries, and parameters for template injection sequences.
 */
const SSTI_PATTERN = /(\$\{[\s\S]*\}|\{\{[\s\S]*\}\}|<%[\s\S]*%>|#\{[\s\S]*\}|\*\{[\s\S]*\}|(\.constructor\s*\[|\bprocess\.mainModule\b|\bchild_process\b))/i;

const inspectValue = (val, path = '') => {
  if (typeof val === 'string') {
    if (SSTI_PATTERN.test(val)) {
      // Check if it contains dangerous function calls or arithmetic evaluations
      if (
        val.includes('constructor') ||
        val.includes('__proto__') ||
        val.includes('require(') ||
        val.includes('global.') ||
        val.includes('process.') ||
        /\$\{.*\(.*\).*\}/.test(val) ||
        /\{\{.*\(.*\).*\}\}/.test(val)
      ) {
        return { isMalicious: true, matched: val.substring(0, 80), path };
      }
    }
  } else if (val && typeof val === 'object') {
    for (const key of Object.keys(val)) {
      // Prevent prototype pollution via SSTI keys
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return { isMalicious: true, matched: key, path: `${path}.${key}` };
      }
      const res = inspectValue(val[key], `${path}.${key}`);
      if (res.isMalicious) return res;
    }
  }
  return { isMalicious: false };
};

const sstiGuard = (req, res, next) => {
  // Check Query
  if (req.query) {
    const qCheck = inspectValue(req.query, 'query');
    if (qCheck.isMalicious) {
      logger.warn(`[SECURITY - SSTI] Blocked potential template injection in query: ${qCheck.path}`, {
        ip: req.ip,
        matched: qCheck.matched,
      });
      return res.status(400).json({
        success: false,
        message: 'Invalid input syntax detected.',
        errorType: 'SecurityViolation',
      });
    }
  }

  // Check Body
  if (req.body) {
    const bCheck = inspectValue(req.body, 'body');
    if (bCheck.isMalicious) {
      logger.warn(`[SECURITY - SSTI] Blocked potential template injection in body: ${bCheck.path}`, {
        ip: req.ip,
        matched: bCheck.matched,
      });
      return res.status(400).json({
        success: false,
        message: 'Invalid payload syntax detected.',
        errorType: 'SecurityViolation',
      });
    }
  }

  next();
};

module.exports = { sstiGuard };

