'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard for GCM
const TAG_LENGTH = 16;

// Derive or get master encryption key (32 bytes)
const getMasterKey = () => {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'edusync_default_enterprise_crypto_key_32b';
  return crypto.createHash('sha256').update(secret).digest();
};

/**
 * Encrypt a plaintext string or object using AES-256-GCM (Authenticated Encryption)
 * @param {string|object} data
 * @param {Buffer} [customKey] Optional custom room or tenant key
 * @returns {string} Encrypted bundle: iv:authTag:ciphertext (hex)
 */
const encrypt = (data, customKey = null) => {
  const key = customKey || getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const text = typeof data === 'object' ? JSON.stringify(data) : String(data);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
};

/**
 * Decrypt an AES-256-GCM encrypted bundle with tamper verification
 * @param {string} encryptedBundle Formatted as iv:authTag:ciphertext
 * @param {Buffer} [customKey]
 * @returns {string} Plaintext string
 */
const decrypt = (encryptedBundle, customKey = null) => {
  if (!encryptedBundle || typeof encryptedBundle !== 'string') return null;

  const parts = encryptedBundle.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted bundle format');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const key = customKey || getMasterKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

/**
 * Constant-time string comparison to prevent timing attacks
 */
const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Constant time dummy check
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Generate cryptographically secure random token
 */
const generateSecureToken = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString('hex');
};

module.exports = {
  encrypt,
  decrypt,
  safeCompare,
  generateSecureToken,
};

