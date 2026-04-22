'use strict';

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'fallback_refresh_secret';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

/**
 * Generate access token
 */
const signAccessToken = (payload) =>
  jwt.sign(
    { ...payload, jti: uuidv4() },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );

/**
 * Generate refresh token
 */
const signRefreshToken = (payload) =>
  jwt.sign(
    { ...payload, jti: uuidv4() },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN, algorithm: 'HS256' }
  );

/**
 * Verify access token
 */
const verifyAccessToken = (token) => jwt.verify(token, JWT_SECRET);

/**
 * Verify refresh token
 */
const verifyRefreshToken = (token) => jwt.verify(token, JWT_REFRESH_SECRET);

/**
 * Generate both tokens for a user
 */
const generateTokenPair = (user) => {
  const payload = {
    sub: user._id.toString(),
    email: user.email,
    role: user.role,
  };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
};

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateTokenPair,
};
