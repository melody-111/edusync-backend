'use strict';

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

// ─── Generate TOTP Secret ─────────────────────────────────────────────────────
const generateSecret = (userEmail) => {
  const secret = speakeasy.generateSecret({
    name: `Digital Classroom (${userEmail})`,
    issuer: 'Digital Classroom',
    length: 32,
  });
  return secret;
};

// ─── Generate QR Code URL ───────────────────────────────────────────────────────
const generateQRCode = async (secret) => {
  try {
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
    return qrCodeUrl;
  } catch (error) {
    logger.error('Error generating QR code:', error);
    throw new Error('Failed to generate QR code');
  }
};

// ─── Verify TOTP Token ───────────────────────────────────────────────────────────
const verifyToken = (secret, token) => {
  const verified = speakeasy.totp.verify({
    secret: secret,
    encoding: 'base32',
    token: token,
    window: 2, // Allow 2 time steps (1 minute) for clock drift
  });
  return verified;
};

// ─── Enable 2FA for User ────────────────────────────────────────────────────────
const enable2FA = async (userId, secret) => {
  try {
    // Store 2FA secret in Redis (or database in production)
    const cacheKey = `2fa_secret:${userId}`;
    await cache.set(cacheKey, secret.base32, 'EX', 86400); // 24 hours expiry
    logger.info(`2FA enabled for user: ${userId}`);
    return true;
  } catch (error) {
    logger.error('Error enabling 2FA:', error);
    throw new Error('Failed to enable 2FA');
  }
};

// ─── Disable 2FA for User ───────────────────────────────────────────────────────
const disable2FA = async (userId) => {
  try {
    const cacheKey = `2fa_secret:${userId}`;
    await cache.del(cacheKey);
    logger.info(`2FA disabled for user: ${userId}`);
    return true;
  } catch (error) {
    logger.error('Error disabling 2FA:', error);
    throw new Error('Failed to disable 2FA');
  }
};

// ─── Check if 2FA is Enabled for User ───────────────────────────────────────────
const is2FAEnabled = async (userId) => {
  try {
    const cacheKey = `2fa_secret:${userId}`;
    const secret = await cache.get(cacheKey);
    return !!secret;
  } catch (error) {
    logger.error('Error checking 2FA status:', error);
    return false;
  }
};

// ─── Get 2FA Secret for User ────────────────────────────────────────────────────
const get2FASecret = async (userId) => {
  try {
    const cacheKey = `2fa_secret:${userId}`;
    const secret = await cache.get(cacheKey);
    return secret;
  } catch (error) {
    logger.error('Error getting 2FA secret:', error);
    return null;
  }
};

module.exports = {
  generateSecret,
  generateQRCode,
  verifyToken,
  enable2FA,
  disable2FA,
  is2FAEnabled,
  get2FASecret,
};
