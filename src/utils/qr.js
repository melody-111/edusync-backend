'use strict';

const QRCode = require('qrcode');
const crypto = require('crypto');

const QR_SECRET = process.env.QR_SECRET || 'qr_dev_secret_change_me';

/**
 * Create a short HMAC signature for the QR payload
 */
const signQrPayload = (sessionId, token) => {
  const data = `${sessionId}:${token}`;
  return crypto.createHmac('sha256', QR_SECRET).update(data).digest('hex').slice(0, 16);
};

/**
 * Generate a secure QR token and return qrToken + qrDataUrl
 * @param {string} sessionId
 * @returns {{ qrToken: string, qrCodeDataUrl: string, qrPayload: object }}
 */
const generateSessionQR = async (sessionId) => {
  // Cryptographically secure random token
  const qrToken = crypto.randomBytes(32).toString('hex');
  const sig = signQrPayload(sessionId, qrToken);

  const qrPayload = {
    sessionId,
    token: qrToken,
    sig,
    v: 1, // schema version
  };

  const qrCodeDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload), {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 300,
    color: { dark: '#1a1a2e', light: '#ffffff' },
  });

  return { qrToken, qrCodeDataUrl, qrPayload };
};

/**
 * Validate a scanned QR payload against stored session token
 * @param {object} scannedPayload  - parsed JSON from QR
 * @param {string} storedToken      - qrToken stored in Session doc
 * @param {string} sessionId        - session._id.toString()
 * @returns {boolean}
 */
const validateQRPayload = (scannedPayload, storedToken, sessionId) => {
  if (!scannedPayload || !scannedPayload.token || !scannedPayload.sig) return false;
  if (scannedPayload.sessionId !== sessionId) return false;
  if (scannedPayload.token !== storedToken) return false;

  // Verify signature
  const expectedSig = signQrPayload(sessionId, scannedPayload.token);
  return crypto.timingSafeEqual(
    Buffer.from(scannedPayload.sig),
    Buffer.from(expectedSig)
  );
};

const generateUserQR = async (user) => {
  const userId = user._id.toString();
  const timestamp = Date.now();
  const token = crypto.randomBytes(16).toString('hex');
  
  const data = `${userId}:${timestamp}:${token}`;
  const sig = crypto.createHmac('sha256', QR_SECRET).update(data).digest('hex').slice(0, 16);

  const qrPayload = {
    userId,
    token,
    ts: timestamp,
    sig,
    role: user.role,
  };

  const qrCodeDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 250,
    color: { dark: '#000000', light: '#ffffff' },
  });

  return { qrCodeDataUrl, qrPayload };
};

module.exports = { generateSessionQR, validateQRPayload, generateUserQR };
