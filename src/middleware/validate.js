'use strict';

const { validationResult } = require('express-validator');
const { sendError } = require('../utils/helpers');

/**
 * Validates express-validator results and short-circuits with 422 on failure
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(
      res,
      'Validation failed',
      422,
      errors.array().map((e) => ({ field: e.path, message: e.msg }))
    );
  }
  return next();
};

module.exports = { validate };
