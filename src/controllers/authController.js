'use strict';

const { body } = require('express-validator');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { totp } = require('otplib');
const crypto = require('crypto');
const QRCode = require('qrcode');

const User = require('../models/User');
const { generateTokenPair, verifyRefreshToken } = require('../utils/jwt');
const { sendOtpEmail } = require('../utils/email');
const { cache } = require('../config/redis');
const TerminalSession = require('../models/TerminalSession');
const { asyncHandler, sendSuccess, sendError, getClientIp } = require('../utils/helpers');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const File = require('../models/File');
const Session = require('../models/Session');
const ActivityLog = require('../models/ActivityLog');
const {
  generateSecret,
  generateQRCode,
  verifyToken,
  enable2FA,
  disable2FA,
  is2FAEnabled,
  get2FASecret,
} = require('../services/twoFactorAuth');

const logActivity = async (data) => {
  try {
    // Fire and forget activity logging
    ActivityLog.create(data).catch(() => { });
  } catch {
    // Ignore log failure
  }
};

// ─── Google OAuth Passport Config ─────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5001/auth/google/callback',
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) return done(new Error('No email from Google'));

          let user = await User.findOne({ 'authProviders.google.googleId': profile.id });

          if (!user) {
            // Try to link to existing email account
            user = await User.findOne({ email });
            if (user) {
              user.authProviders.google = { googleId: profile.id, accessToken };
              user.isVerified = true;
              if (!user.avatar) user.avatar = profile.photos?.[0]?.value || null;
              await user.save();
            } else {
              // Create new user — default role: student (teacher role assigned manually)
              user = await User.create({
                email,
                name: profile.displayName || email.split('@')[0],
                avatar: profile.photos?.[0]?.value || null,
                role: 'student',
                isVerified: true,
                authProviders: {
                  google: { googleId: profile.id, accessToken },
                },
              });
            }
          }

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );
}

// ─── OTP Config ───────────────────────────────────────────────────────────────
totp.options = { step: parseInt(process.env.OTP_STEP, 10) || 300, digits: 6 };

const generateOtp = () => {
  // Use crypto-random 6-digit OTP instead of TOTP for simplicity across devices
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /auth/login-password
 * Accepts: { email, password }
 * Returns: { accessToken, refreshToken, user }
 */
const loginWithPassword = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return sendError(res, 'Invalid email or password', 401);
  if (!user.isActive) return sendError(res, 'Account disabled', 403);

  const isValidPassword = await user.verifyPassword(password);
  if (!isValidPassword) return sendError(res, 'Invalid email or password', 401);

  user.lastLoginAt = new Date();
  user.lastLoginIp = getClientIp(req);
  await user.save();

  const { accessToken, refreshToken } = generateTokenPair(user);

  // Store refresh token hash
  user.refreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await user.save({ validateBeforeSave: false });

  logActivity({ userId: user._id, actorRole: user.role, action: 'auth.login', category: 'auth', ip: getClientIp(req) });

  return sendSuccess(res, {
    accessToken,
    refreshToken,
    user: user.toSafeObject(),
  }, 'Login successful');
});

/**
 * POST /auth/set-password
 * Accepts: { password }
 */
const setPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) return sendError(res, 'Password is required', 400);

  const user = await User.findById(req.user._id);
  if (!user) return sendError(res, 'User not found', 404);

  await user.setPassword(password);
  await user.save({ validateBeforeSave: false });

  logActivity({ userId: user._id, actorRole: user.role, action: 'auth.password.set', category: 'auth', ip: getClientIp(req) });

  return sendSuccess(res, null, 'Password set successfully');
});

/**
 * POST /auth/login
 * Accepts: { email, role, name, rollNumber, course, branch, semester, year, section, institutionType, subjectId, subjectName, gmail }
 * Sends OTP to email or phone based on input
 */
const login = asyncHandler(async (req, res) => {
  const { email, role, name, rollNumber, course, branch, semester, year, section, institutionType, subjectId, subjectName, gmail } = req.body;

  // Detect if input is email or phone
  const isEmail = email.includes('@');
  const isPhone = /^\d{10}$/.test(email.replace(/[\s-]/g, ''));

  if (!isEmail && !isPhone) {
    return sendError(res, 'Please enter a valid email or phone number', 400);
  }

  let user = await User.findOne({ email: email.toLowerCase() });

  if (!user) {
    const userData = {
      email: email.toLowerCase(),
      name: name || email.split('@')[0],
      role: role || 'student',
      isVerified: false,
      authProviders: {},
    };

    // Add academic profile fields if provided
    if (rollNumber) userData.rollNumber = rollNumber;
    if (course) userData.course = course;
    if (branch) userData.branch = branch;
    if (semester) userData.semester = semester;
    if (year) userData.year = year;
    if (section) userData.section = section;
    if (institutionType) userData.institutionType = institutionType;
    if (subjectId) userData.subjectId = subjectId;
    if (subjectName) userData.subjectName = subjectName;
    if (gmail) userData.gmail = gmail;

    if (userData.role === 'teacher') {
      // Generate a permanent special ID for the teacher (Desk ID)
      userData.deskId = 'TCH-' + Math.floor(100000 + Math.random() * 900000).toString();
    }

    user = await User.create(userData);

    // Set password if provided
    if (req.body.password) {
      await user.setPassword(req.body.password);
      await user.save({ validateBeforeSave: false });
    }
  } else {
    // Update existing user with new profile data if provided
    if (name) user.name = name;
    if (rollNumber) user.rollNumber = rollNumber;
    if (course) user.course = course;
    if (branch) user.branch = branch;
    if (semester) user.semester = semester;
    if (year) user.year = year;
    if (section) user.section = section;
    if (institutionType) user.institutionType = institutionType;
    if (subjectId) user.subjectId = subjectId;
    if (subjectName) user.subjectName = subjectName;
    if (gmail) user.gmail = gmail;
    await user.save({ validateBeforeSave: false });
  }

  const otp = generateOtp();
  const otpKey = `otp:${email.toLowerCase()}`;
  const otpExpiry = 5 * 60; // 5 minutes

  await cache.setJSON(otpKey, { otp, userId: user._id.toString() }, otpExpiry);

  try {
    if (isEmail) {
      await sendOtpEmail(user.email, otp, user.name);
    } else if (isPhone) {
      // TODO: Implement SMS sending using Twilio or similar service
      // For now, log OTP to console for phone numbers in dev
      logger.debug(`[DEV] OTP for phone ${email}: ${otp}`);
      if (process.env.NODE_ENV === 'production') {
        return sendError(res, 'SMS OTP not configured. Please use email.', 503);
      }
    }
  } catch (err) {
    logger.error(`OTP send failed: ${err.message}`);
    // In dev, log the OTP to console rather than failing
    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`[DEV] OTP for ${email}: ${otp}`);
    } else {
      return sendError(res, 'Failed to send OTP. Please try again.', 503);
    }
  }

  logActivity({ userId: user._id, actorRole: user.role, action: 'auth.otp.sent', category: 'auth', ip: getClientIp(req) });

  const message = isEmail ? 'OTP sent to your email' : 'OTP sent to your phone';
  return sendSuccess(res, { email: user.email, expiresInSeconds: otpExpiry }, message);
});

/**
 * POST /auth/verify-otp
 * Accepts: { email, otp }
 * Returns: { accessToken, refreshToken, user }
 */
const verifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  // Dev mode OTP bypass removed for security



  // Normal OTP verification
  const otpKey = `otp:${email.toLowerCase()}`;
  const stored = await cache.getJSON(otpKey);

  if (!stored) return sendError(res, 'OTP expired or not found. Please request a new one.', 400);
  if (stored.otp !== otp.toString()) return sendError(res, 'Invalid OTP', 400);

  // Consume OTP immediately (prevent replay)
  await cache.del(otpKey);

  const user = await User.findById(stored.userId);
  if (!user) return sendError(res, 'User not found', 404);
  if (!user.isActive) return sendError(res, 'Account disabled', 403);

  user.isVerified = true;
  user.lastLoginAt = new Date();
  user.lastLoginIp = getClientIp(req);
  await user.save();

  const { accessToken, refreshToken } = generateTokenPair(user);

  // Store refresh token hash
  user.refreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await user.save({ validateBeforeSave: false });

  logActivity({ userId: user._id, actorRole: user.role, action: 'auth.login', category: 'auth', ip: getClientIp(req) });

  // DEV: emit teacher:online if user is teacher
  if (user.role === 'teacher') {
    const { getSocketServer } = require('../socket/server');
    const io = getSocketServer();
    if (io) {
      const targetRoom = user.classroomId
        ? `classroom:${user.classroomId}`
        : `edu:${user.branch || 'any'}:${user.year || 'any'}:${user.semester || 'any'}`;

      io.to(targetRoom).emit('teacher:online', {
        teacherName: user.name,
        deskId: user.deskId,
        message: 'Teacher has entered the class. Please get ready!',
      });
    }
  }

  return sendSuccess(res, {
    accessToken,
    refreshToken,
    user: user.toSafeObject(),
  }, 'Login successful');
});

/**
 * POST /auth/qr-login
 * Mobile app scans a user's unique QR login token and gets authenticated.
 */
const qrLogin = asyncHandler(async (req, res) => {
  const { qrToken } = req.body;
  if (!qrToken) return sendError(res, 'QR login token required', 400);

  // Authenticate by token (the token is stored as qrLoginToken in the User model)
  const user = await User.findOne({ qrLoginToken: qrToken }).select('+refreshToken');
  if (!user) return sendError(res, 'Invalid QR login token or user not found.', 401);
  if (!user.isActive) return sendError(res, 'Account disabled', 403);

  user.lastLoginAt = new Date();
  user.lastLoginIp = getClientIp(req);
  user.isVerified = true;
  await user.save();

  const { accessToken, refreshToken: rt } = generateTokenPair(user);

  // Update refresh token hash
  user.refreshToken = crypto.createHash('sha256').update(rt).digest('hex');
  await user.save({ validateBeforeSave: false });

  logActivity({ userId: user._id, actorRole: user.role, action: 'auth.qr.login', category: 'auth', ip: getClientIp(req) });

  return sendSuccess(res, {
    accessToken,
    refreshToken: rt,
    user: user.toSafeObject(),
  }, 'Logged in via QR scan');
});

/**
 * GET /auth/me
 * Returns current user info
 */
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, { user });
});

/**
 * PUT /auth/profile
 * Updates academic profile fields
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { name, rollNumber, semester, year, branch, course, avatar, institutionType, section, subjectId, subjectName, gmail } = req.body;
  const user = await User.findById(req.user._id);

  if (!user) return sendError(res, 'User not found', 404);

  if (name) user.name = name;
  if (rollNumber) user.rollNumber = rollNumber;
  if (semester) user.semester = semester;
  if (year) user.year = year;
  if (branch) user.branch = branch;
  if (course) user.course = course;
  if (avatar) user.avatar = avatar;
  if (institutionType) user.institutionType = institutionType;
  if (section) user.section = section;
  if (subjectId) user.subjectId = subjectId;
  if (subjectName) user.subjectName = subjectName;
  if (gmail) user.gmail = gmail;

  await user.save();

  logActivity({ userId: user._id, actorRole: user.role, action: 'auth.profile.update', category: 'auth' });

  return sendSuccess(res, { user: user.toSafeObject() }, 'Profile updated successfully');
});

/**
 * POST /auth/refresh
 * Accepts: { refreshToken }
 * Returns: { accessToken, refreshToken }
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) return sendError(res, 'Refresh token required', 400);

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    return sendError(res, 'Invalid or expired refresh token', 401);
  }

  const user = await User.findById(decoded.sub).select('+refreshToken');
  if (!user) return sendError(res, 'User not found', 401);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (user.refreshToken !== tokenHash) return sendError(res, 'Refresh token mismatch', 401);

  const tokens = generateTokenPair(user);
  user.refreshToken = crypto.createHash('sha256').update(tokens.refreshToken).digest('hex');
  await user.save({ validateBeforeSave: false });

  return sendSuccess(res, tokens, 'Tokens refreshed');
});

/**
 * POST /auth/logout
 */
const logout = asyncHandler(async (req, res) => {
  const { jti } = req.tokenPayload;
  // Blacklist current token jti
  const ttl = Math.max(0, req.tokenPayload.exp - Math.floor(Date.now() / 1000));
  if (ttl > 0) await cache.set(`blacklist:${jti}`, '1', ttl);

  // Clear refresh token and invalidate active sessions
  const Session = require('../models/Session');
  const activeSessions = await Session.find({ ownerId: req.user._id, status: 'active' });

  for (const session of activeSessions) {
    session.status = 'ended';
    session.endedAt = new Date();
    session.qrToken = crypto.randomBytes(16).toString('hex'); // Invalidate QR
    await session.save();
    await cache.del(`session:${session.sessionId}`);
  }

  const newQrToken = crypto.randomBytes(32).toString('hex');
  await User.findByIdAndUpdate(req.user._id, {
    refreshToken: null,
    qrLoginToken: newQrToken
  });

  logActivity({ userId: req.user._id, actorRole: req.user.role, action: 'auth.logout', category: 'auth', ip: getClientIp(req) });

  return sendSuccess(res, null, 'Logged out successfully and active sessions ended');
});

/**
 * POST /auth/signup
 */
const signup = asyncHandler(async (req, res) => {
  const { 
    email, password, name, role, institutionType, 
    className, rollNumber, subject, idNumber, 
    branch, course, semester, year, institutionName
  } = req.body;

  if (!email) {
    return sendError(res, 'Email is required', 400);
  }

  let user = await User.findOne({ email: email.toLowerCase() });
  
  if (user) {
    // If the user has already verified and has a password, they are fully registered.
    if (user.isVerified && user.authProviders?.local?.passwordHash) {
      return sendError(res, 'User already exists', 400);
    }
    
    // If they exist but are not fully verified (e.g. from a previous incomplete signup or Google login),
    // we update their info instead of blocking them.
    if (name) user.name = name;
    if (role) user.role = role;
    if (institutionType) user.institutionType = institutionType;
    if (institutionName) user.institutionName = institutionName;
    if (className) user.className = className;
    if (rollNumber) user.rollNumber = rollNumber;
    if (subject) user.subjectId = subject;
    if (idNumber) user.idNumber = idNumber;
    if (branch) user.branch = branch;
    if (course) user.course = course;
    if (semester) user.semester = semester;
    if (year) user.year = year;

    if (password) {
      await user.setPassword(password);
    }
    await user.save({ validateBeforeSave: false });
  } else {
    const userData = {
      email: email.toLowerCase(),
      name: name || email.split('@')[0],
      role: role || 'student',
      isVerified: false,
    };

    if (institutionType) userData.institutionType = institutionType;
    if (institutionName) userData.institutionName = institutionName;
    if (className) userData.className = className;
    if (rollNumber) userData.rollNumber = rollNumber;
    if (subject) userData.subjectId = subject; 
    if (idNumber) userData.idNumber = idNumber;
    if (branch) userData.branch = branch;
    if (course) userData.course = course;
    if (semester) userData.semester = semester;
    if (year) userData.year = year;

    if (userData.role === 'teacher') {
      userData.deskId = 'TCH-' + Math.floor(100000 + Math.random() * 900000).toString();
    }

    user = await User.create(userData);

    if (password) {
      await user.setPassword(password);
      await user.save({ validateBeforeSave: false });
    }
  }

  const otp = generateOtp();
  const otpKey = `otp:${email.toLowerCase()}`;
  await cache.setJSON(otpKey, { otp, userId: user._id.toString() }, 300);

  try {
    await sendOtpEmail(user.email, otp, user.name);
  } catch (err) {
    // Graceful error handling for email sending in dev
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Signup OTP for ${email}: ${otp}`);
    } else {
      return sendError(res, 'Failed to send OTP email', 500);
    }
  }

  return sendSuccess(res, { email: user.email }, 'Signup successful, please verify OTP');
});

/**
 * POST /auth/forgot-password
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user) {
    // Return success anyway to prevent email enumeration
    return sendSuccess(res, null, 'If an account exists, a reset OTP has been sent');
  }

  const otp = generateOtp();
  const otpKey = `pwdreset_otp:${email.toLowerCase()}`;
  await cache.setJSON(otpKey, { otp, userId: user._id.toString() }, 600); // 10 mins

  try {
    await sendOtpEmail(user.email, otp, user.name);
  } catch (err) {
    logger.error(`OTP send failed: ${err.message}`);
    return sendError(res, 'Failed to send OTP. Please try again.', 503);
  }

  return sendSuccess(res, null, 'Password reset OTP sent to email');
});

/**
 * POST /auth/verify-reset-otp
 */
const verifyResetOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return sendError(res, 'Email and OTP are required', 400);
  }

  const otpKey = `pwdreset_otp:${email.toLowerCase()}`;
  const stored = await cache.getJSON(otpKey);

  if (!stored) {
    return sendError(res, 'OTP expired or not found. Please request a new one.', 400);
  }

  if (stored.otp !== otp.toString()) {
    return sendError(res, 'Invalid OTP', 400);
  }

  // Do not consume the OTP yet, it will be consumed in resetPassword
  return sendSuccess(res, null, 'OTP is valid');
});

/**
 * POST /auth/reset-password
 */
const resetPassword = asyncHandler(async (req, res) => {
  // Mobile app passes: { email, otp, newPassword }
  const { email, token, otp, newPassword } = req.body;
  const actualOtp = otp || token; // Fallback for 'token' just in case

  if (!email || !actualOtp || !newPassword) {
    return sendError(res, 'Email, OTP, and new password are required', 400);
  }

  const otpKey = `pwdreset_otp:${email.toLowerCase()}`;
  const stored = await cache.getJSON(otpKey);

  if (!stored) {
    return sendError(res, 'OTP expired or not found. Please request a new one.', 400);
  }

  if (stored.otp !== actualOtp.toString()) {
    return sendError(res, 'Invalid OTP', 400);
  }

  const user = await User.findById(stored.userId);
  if (!user) {
    return sendError(res, 'User not found', 404);
  }

  await user.setPassword(newPassword);
  await user.save({ validateBeforeSave: false });

  // Consume OTP immediately
  await cache.del(otpKey);

  return sendSuccess(res, null, 'Password reset successful');
});

// ─── Google OAuth Routes ───────────────────────────────────────────────────────
const googleAuth = passport.authenticate('google', { scope: ['profile', 'email'], session: false });

const googleCallback = [
  passport.authenticate('google', { session: false, failureRedirect: '/auth/google/failure' }),
  asyncHandler(async (req, res) => {
    const { accessToken, refreshToken: rt } = generateTokenPair(req.user);
    req.user.lastLoginAt = new Date();
    await User.findByIdAndUpdate(req.user._id, { lastLoginAt: new Date() });

    logActivity({ userId: req.user._id, actorRole: req.user.role, action: 'auth.google.login', category: 'auth' });

    // Redirect with tokens (or return JSON for mobile)
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    return res.redirect(
      `${clientUrl}/auth/callback?accessToken=${accessToken}&refreshToken=${rt}`
    );
  }),
];

// ─── Validation Rules ──────────────────────────────────────────────────────────
const loginValidation = [
  body('email').notEmpty().trim().withMessage('Email or Phone required'),
  body('role').optional().isIn(['teacher', 'student']).withMessage('Role must be teacher or student'),
];

const verifyOtpValidation = [
  body('email').notEmpty().trim().withMessage('Email or Phone required'),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric().withMessage('OTP must be 6 digits'),
];

const qrLoginValidation = [
  body('qrToken').notEmpty().withMessage('QR login token is required'),
];

/**
 * GET /auth/qr-token
 * Returns the current user's personal QR login token as a scannable data URL.
 * This QR is static (tied to the account) and used by the mobile app to sign-in instantly.
 * Works for both teacher and student.
 */
const getMyQrToken = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+qrLoginToken +lastQrRefreshAt');
  if (!user) return sendError(res, 'User not found', 404);

  // Generate token if not yet created
  if (!user.qrLoginToken) {
    user.qrLoginToken = crypto.randomBytes(32).toString('hex');
    user.lastQrRefreshAt = new Date();
    await user.save({ validateBeforeSave: false });
  }

  // Build QR payload (app will POST this to /auth/qr-login)
  const payload = JSON.stringify({ qrToken: user.qrLoginToken, userId: user._id.toString() });

  // Generate QR code as data URL
  const qrCodeDataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    width: 300,
    margin: 2,
  });

  return sendSuccess(res, {
    qrCodeDataUrl,
    qrToken: user.qrLoginToken,
    userId: user._id,
    name: user.name,
    role: user.role,
  }, 'Your personal QR login token');
});

/**
 * POST /auth/qr-token/regenerate
 * Rotates (invalidates) the current QR login token and generates a fresh one.
 * Use this if the user suspects their QR was compromised.
 */
const regenerateQrToken = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+qrLoginToken');
  if (!user) return sendError(res, 'User not found', 404);

  // Rotate token
  user.qrLoginToken = crypto.randomBytes(32).toString('hex');
  user.lastQrRefreshAt = new Date();
  await user.save({ validateBeforeSave: false });

  const payload = JSON.stringify({ qrToken: user.qrLoginToken, userId: user._id.toString() });
  const qrCodeDataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    width: 300,
    margin: 2,
  });

  logActivity({
    userId: user._id,
    actorRole: user.role,
    action: 'auth.qr.regenerate',
    category: 'auth',
    ip: getClientIp(req),
  });

  return sendSuccess(res, {
    qrCodeDataUrl,
    qrToken: user.qrLoginToken,
    message: 'Old QR token has been invalidated. Use the new QR.',
  }, 'QR token regenerated successfully');
});

/**
 * GET /auth/qr-token/refresh
 * Refreshes the personal QR code with a new token (every minute)
 * Works for both teacher and student
 */
const refreshQrToken = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+qrLoginToken +lastQrRefreshAt');
  if (!user) return sendError(res, 'User not found', 404);

  // Check if enough time has passed since last refresh (at least 60 seconds)
  const now = new Date();
  const timeSinceLastRefresh = user.lastQrRefreshAt ? (now - new Date(user.lastQrRefreshAt)) / 1000 : 61; // in seconds
  if (timeSinceLastRefresh < 60) {
    return sendSuccess(res, {
      qrCodeDataUrl: null,
      message: 'QR code can only be refreshed every minute',
      nextRefreshIn: Math.ceil(60 - timeSinceLastRefresh)
    }, 'QR refresh not allowed yet');
  }

  // Generate new QR token
  user.qrLoginToken = crypto.randomBytes(32).toString('hex');
  user.lastQrRefreshAt = now;
  await user.save({ validateBeforeSave: false });

  const payload = JSON.stringify({ qrToken: user.qrLoginToken, userId: user._id.toString() });
  const qrCodeDataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    width: 300,
    margin: 2,
  });

  logActivity({
    userId: user._id,
    actorRole: user.role,
    action: 'auth.qr.refresh',
    category: 'auth',
    ip: getClientIp(req),
  });

  return sendSuccess(res, {
    qrCodeDataUrl,
    qrToken: user.qrLoginToken,
    message: 'QR code refreshed successfully'
  }, 'Personal QR code refreshed');
});

/**
 * GET /auth/terminal/init
 * Initializes a new terminal session with a unique token and QR data.
 */
const initTerminal = asyncHandler(async (req, res) => {
  const terminalId = uuidv4();
  const qrToken = crypto.randomBytes(32).toString('hex');
  const ip = getClientIp(req);
  const EXPIRES_IN = 65; // 65 seconds (gives a buffer over 60s)

  await TerminalSession.create({
    terminalId,
    qrToken,
    ipAddress: ip,
    expiresAt: new Date(Date.now() + EXPIRES_IN * 1000),
    lastRefreshedAt: new Date(),
  });

  // Paylod for teacher mobile app (must scan this)
  const payload = JSON.stringify({
    type: 'terminal_sync',
    terminalId,
    qrToken
  });

  const qrCodeDataUrl = await QRCode.toDataURL(payload, {
    width: 400,
    margin: 2,
    color: { dark: '#1a1a2e', light: '#ffffff' },
  });

  return sendSuccess(res, { terminalId, qrCodeDataUrl, expiresIn: EXPIRES_IN }, 'Terminal initialized');
});

/**
 * GET /auth/terminal/refresh/:terminalId
 * Refreshes the terminal QR code with a new token (every minute)
 */
const refreshTerminalQr = asyncHandler(async (req, res) => {
  const { terminalId } = req.params;
  const terminal = await TerminalSession.findOne({ terminalId, status: 'pending' });

  if (!terminal) return sendError(res, 'Terminal session expired or not found', 404);

  // Check if enough time has passed since last refresh (at least 60 seconds)
  const now = new Date();
  const timeSinceLastRefresh = (now - new Date(terminal.lastRefreshedAt)) / 1000; // in seconds
  if (timeSinceLastRefresh < 60) {
    return sendSuccess(res, {
      qrCodeDataUrl: null,
      message: 'QR code can only be refreshed every minute',
      nextRefreshIn: Math.ceil(60 - timeSinceLastRefresh)
    }, 'QR refresh not allowed yet');
  }

  // Generate new QR token
  const newQrToken = crypto.randomBytes(32).toString('hex');
  terminal.qrToken = newQrToken;
  terminal.lastRefreshedAt = now;
  // Extend expiry by 65 seconds from now
  terminal.expiresAt = new Date(Date.now() + 65 * 1000);
  await terminal.save();

  // Generate new QR code
  const payload = JSON.stringify({
    type: 'terminal_sync',
    terminalId,
    qrToken: newQrToken
  });

  const qrCodeDataUrl = await QRCode.toDataURL(payload, {
    width: 400,
    margin: 2,
    color: { dark: '#1a1a2e', light: '#ffffff' },
  });

  logActivity({
    userId: terminal.userId,
    actorRole: 'teacher',
    action: 'terminal.qr.refresh',
    category: 'auth',
    details: { terminalId },
  });

  return sendSuccess(res, {
    terminalId,
    qrCodeDataUrl,
    expiresIn: 65,
    message: 'QR code refreshed successfully'
  }, 'Terminal QR code refreshed');
});

/**
 * GET /auth/terminal/status/:terminalId
 * Poll endpoint for the teacher screen to see if sync is complete.
 */
const checkTerminalStatus = asyncHandler(async (req, res) => {
  const { terminalId } = req.params;
  const terminal = await TerminalSession.findOne({ terminalId });

  if (!terminal) return sendError(res, 'Terminal session expired or not found', 404);

  if (terminal.status === 'synced') {
    return sendSuccess(res, {
      status: 'synced',
      accessToken: terminal.accessToken,
      refreshToken: terminal.refreshToken,
    }, 'Terminal synced successfully');
  }

  return sendSuccess(res, { status: 'pending' }, 'Waiting for scan');
});

/**
 * POST /auth/terminal/sync
 * Called by authenticated Teacher Mobile App after scanning terminal QR.
 */
const syncTerminal = asyncHandler(async (req, res) => {
  const { terminalId, qrToken } = req.body;
  const user = req.user;

  if (!['teacher', 'student'].includes(user.role)) {
    return sendError(res, 'Invalid role for terminal sync', 403);
  }

  const terminal = await TerminalSession.findOne({ terminalId, qrToken, status: 'pending' });
  if (!terminal) return sendError(res, 'Invalid or expired sync token', 400);

  // Generate tokens for the terminal
  const { accessToken, refreshToken } = generateTokenPair(user);

  // Update terminal record
  terminal.status = 'synced';
  terminal.userId = user._id;
  terminal.accessToken = accessToken;
  terminal.refreshToken = refreshToken;
  await terminal.save();

  // Notify terminal via socket
  const { notifyTerminalSynced, getSocketServer } = require('../socket/server');
  notifyTerminalSynced(terminalId, {
    accessToken,
    refreshToken,
    user: user.toSafeObject(),
  });

  // Notify students/screens in the same classroom/branch that the teacher is online
  const io = getSocketServer();
  if (io) {
    const targetRoom = user.classroomId
      ? `classroom:${user.classroomId}`
      : `edu:${user.branch || 'any'}:${user.year || 'any'}:${user.semester || 'any'}`;

    io.to(targetRoom).emit('teacher:online', {
      teacherName: user.name,
      deskId: user.deskId,
      message: 'Teacher has entered the class. Please get ready!',
    });
  }

  logActivity({
    userId: user._id,
    actorRole: 'teacher',
    action: 'terminal.sync',
    category: 'auth',
    details: { terminalId, ip: terminal.ipAddress },
  });

  return sendSuccess(res, null, 'Terminal synced successfully');
});

// Search teacher by ID or deskId
const searchTeacher = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Search by deskId or _id
  const teacher = await User.findOne({
    $or: [
      { deskId: id },
      { _id: id }
    ],
    role: 'teacher',
    isActive: true
  });

  if (!teacher) {
    return sendError(res, 'Teacher not found', 404);
  }

  // Check if teacher has an active session
  const Session = require('../models/Session');
  const activeSession = await Session.findOne({
    teacherId: teacher._id,
    status: 'active'
  });

  const teacherData = teacher.toSafeObject();
  teacherData.isLive = !!activeSession;
  teacherData.roomId = activeSession?.roomId || null;
  teacherData.sessionId = activeSession?.sessionId || null;

  return sendSuccess(res, { user: teacherData }, 'Teacher found');
});

// ─── 2FA Endpoints ─────────────────────────────────────────────────────────────

// Generate 2FA secret and QR code
const setup2FA = asyncHandler(async (req, res) => {
  const user = req.user;

  // Only admin can enable 2FA
  if (user.role !== 'admin') {
    return sendError(res, 'Only admin users can enable 2FA', 403);
  }

  const secret = generateSecret(user.email);
  const qrCode = await generateQRCode(secret);

  return sendSuccess(res, {
    secret: secret.base32,
    qrCode,
    message: 'Scan QR code with Google Authenticator or Authy'
  }, '2FA setup initiated');
});

// Enable 2FA (after user scans QR code)
const enable2FAEndpoint = asyncHandler(async (req, res) => {
  const user = req.user;
  const { secret, token } = req.body;

  if (user.role !== 'admin') {
    return sendError(res, 'Only admin users can enable 2FA', 403);
  }

  // Verify the token before enabling
  const isValid = verifyToken(secret, token);
  if (!isValid) {
    return sendError(res, 'Invalid 2FA token', 400);
  }

  await enable2FA(user._id.toString(), secret);

  return sendSuccess(res, null, '2FA enabled successfully');
});

// Verify 2FA token during login
const verify2FA = asyncHandler(async (req, res) => {
  const { userId, token } = req.body;

  const secret = await get2FASecret(userId);
  if (!secret) {
    return sendError(res, '2FA not enabled for this user', 400);
  }

  const isValid = verifyToken(secret, token);
  if (!isValid) {
    return sendError(res, 'Invalid 2FA token', 400);
  }

  return sendSuccess(res, null, '2FA verified successfully');
});

// Disable 2FA
const disable2FAEndpoint = asyncHandler(async (req, res) => {
  const user = req.user;

  if (user.role !== 'admin') {
    return sendError(res, 'Only admin users can disable 2FA', 403);
  }

  await disable2FA(user._id.toString());

  return sendSuccess(res, null, '2FA disabled successfully');
});

// Check 2FA status
const check2FAStatus = asyncHandler(async (req, res) => {
  const user = req.user;

  const isEnabled = await is2FAEnabled(user._id.toString());

  return sendSuccess(res, { enabled: isEnabled }, '2FA status retrieved');
});

/**
 * GET /auth/dashboard-stats
 */
const getDashboardStats = asyncHandler(async (req, res) => {
  const user = req.user;

  const noteCount = await File.countDocuments({ ownerId: user._id, isDeleted: false });
  const activeSessionCount = await Session.countDocuments({ 
    $or: [
      { teacherId: user._id, status: 'active' }, 
      { participants: user._id, status: 'active' }
    ] 
  });
  
  // Total interaction count from activity logs
  const interactionCount = await ActivityLog.countDocuments({ userId: user._id });

  return sendSuccess(res, {
    noteCount,
    activeSessionCount,
    interactionCount,
    lastSync: new Date().toISOString()
  });
});

module.exports = {
  login,
  loginWithPassword,
  verifyOtp,
  qrLogin,
  getMe,
  updateProfile,
  refreshToken,
  logout,
  setup2FA,
  enable2FA: enable2FAEndpoint,
  verify2FA,
  disable2FA: disable2FAEndpoint,
  check2FAStatus,
  setPassword,
  signup,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  googleAuth,
  googleCallback,
  getMyQrToken,
  regenerateQrToken,
  refreshQrToken,
  initTerminal,
  refreshTerminalQr,
  checkTerminalStatus,
  syncTerminal,
  searchTeacher,
  getDashboardStats,
  loginValidation,
  verifyOtpValidation,
  qrLoginValidation,
};
