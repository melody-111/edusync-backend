'use strict';

const express = require('express');
const router = express.Router();

const {
  login, loginWithPassword, verifyOtp, qrLogin, getMe, updateProfile, refreshToken, logout,
  googleAuth, googleCallback,
  getMyQrToken, regenerateQrToken, refreshQrToken,
  initTerminal, refreshTerminalQr, checkTerminalStatus, syncTerminal, setPassword,
  getDashboardStats,
  loginValidation, verifyOtpValidation, qrLoginValidation,
  setup2FA, enable2FA, verify2FA, disable2FA, check2FAStatus,
} = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authLimiter, otpLimiter } = require('../middleware/rateLimiter');

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and profile management
 */

// POST /auth/login — send OTP to email

router.post('/login', authLimiter, loginValidation, validate, login);

// POST /auth/login-password — login with email and password
router.post('/login-password', authLimiter, validate, loginWithPassword);

// POST /auth/signup — register new user
router.post('/signup', authLimiter, validate, require('../controllers/authController').signup);

// POST /auth/forgot-password — send password reset email
router.post('/forgot-password', authLimiter, validate, require('../controllers/authController').forgotPassword);

// POST /auth/verify-reset-otp — verify OTP for password reset
router.post('/verify-reset-otp', otpLimiter, validate, require('../controllers/authController').verifyResetOtp);

// POST /auth/reset-password — reset password with token
router.post('/reset-password', authLimiter, validate, require('../controllers/authController').resetPassword);

// POST /auth/verify-otp — verify OTP, get JWT tokens
router.post('/verify-otp', otpLimiter, verifyOtpValidation, validate, verifyOtp);

// POST /auth/qr-login — Mobile app scans QR token to authenticate instantly
router.post('/qr-login', authLimiter, qrLoginValidation, validate, qrLogin);

// GET  /auth/me — get current user info
router.get('/me', authenticate, getMe);

// GET  /auth/teacher/:id — search teacher by ID or deskId
router.get('/teacher/:id', authenticate, require('../controllers/authController').searchTeacher);

// PUT  /auth/profile — update academic profile (rollNo, branch, semester, etc.)
router.put('/profile', authenticate, updateProfile);

// POST /auth/set-password — set a new password for the account
router.post('/set-password', authenticate, setPassword);

// GET  /auth/dashboard-stats — get real-time stats for the user
router.get('/dashboard-stats', authenticate, getDashboardStats);

// POST /auth/refresh — exchange refresh token for new access token
router.post('/refresh', authLimiter, refreshToken);

// POST /auth/logout — blacklist current token
router.post('/logout', authenticate, logout);

// ─── QR Login Token (Mobile App Personal QR) ──────────────────────────────────
// GET  /auth/qr-token           — get personal QR code as scannable image data URL
router.get('/qr-token', authenticate, getMyQrToken);

// GET  /auth/qr-token/refresh    — refresh personal QR code every minute
router.get('/qr-token/refresh', authenticate, refreshQrToken);

// POST /auth/qr-token/regenerate — rotate QR token (invalidate old, issue new)
router.post('/qr-token/regenerate', authenticate, regenerateQrToken);

// ─── Terminal Syncing (Large Primary QR) ──────────────────────────────────────
router.get('/terminal/init', initTerminal);
router.get('/terminal/refresh/:terminalId', refreshTerminalQr);
router.get('/terminal/status/:terminalId', checkTerminalStatus);
router.post('/terminal/sync', authenticate, syncTerminal);

// ─── Google OAuth ──────────────────────────────────────────────────────────────
// GET /auth/google — initiate Google OAuth flow
router.get('/google', googleAuth);

// GET /auth/google/callback — OAuth callback
router.get('/google/callback', ...googleCallback);

// GET /auth/google/failure — OAuth failure fallback
router.get('/google/failure', (req, res) =>
  res.status(401).json({ success: false, message: 'Google authentication failed' })
);

// ─── 2FA Endpoints (Admin Only) ──────────────────────────────────────────────────
// POST /auth/2fa/setup — generate 2FA secret and QR code
router.post('/2fa/setup', authenticate, setup2FA);

// POST /auth/2fa/enable — enable 2FA after scanning QR code
router.post('/2fa/enable', authenticate, enable2FA);

// POST /auth/2fa/verify — verify 2FA token during login
router.post('/2fa/verify', verify2FA);

// POST /auth/2fa/disable — disable 2FA
router.post('/2fa/disable', authenticate, disable2FA);

// GET /auth/2fa/status — check 2FA status
router.get('/2fa/status', authenticate, check2FAStatus);

module.exports = router;
