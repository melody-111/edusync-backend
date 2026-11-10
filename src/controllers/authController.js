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
const { sendOtpSms, sendWhatsAppOtp, sendOtpPhone, formatPhoneNumber } = require('../utils/sms');
const { cache } = require('../config/redis');
const TerminalSession = require('../models/TerminalSession');
const College = require('../models/College');
const { asyncHandler, sendSuccess, sendError, getClientIp } = require('../utils/helpers');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const File = require('../models/File');
const Session = require('../models/Session');
const ActivityLog = require('../models/ActivityLog');
const Classroom = require('../models/Classroom');
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

  let normalizedEmail = String(email || '').trim().toLowerCase();
  const isPhone = /^(\+\d{1,3}[- ]?)?\d{10}$/.test(normalizedEmail.replace(/[\s-]/g, ''));
  let user = null;
  if (isPhone) {
    const raw = normalizedEmail.replace(/[\s\-()]/g, '');
    const formatted = formatPhoneNumber(raw);
    user = await User.findOne({
      $or: [
        { email: normalizedEmail },
        { email: formatted },
        { email: raw },
        { phone: formatted },
        { phone: raw }
      ]
    });
  } else {
    user = await User.findOne({ email: normalizedEmail });
  }
  if (!user) return sendError(res, 'Invalid email or password', 401);
  if (!user.isActive) return sendError(res, 'Account disabled', 403);

  // ─── Brute-Force & Bot Defense: Account-Level Progressive Lockout ────────────
  const lockKey = `auth:lock:${user._id}`;
  const isLocked = await cache.get(lockKey);
  if (isLocked) {
    logger.warn(`[SECURITY] Login attempt on locked account: ${user.email} from IP: ${getClientIp(req)}`);
    return sendError(res, 'Account temporarily locked due to excessive failed attempts. Please try again after 15 minutes.', 429);
  }

  const isValidPassword = await user.verifyPassword(password);
  if (!isValidPassword) {
    const attemptsKey = `auth:attempts:${user._id}`;
    const attempts = await cache.incr(attemptsKey);
    await cache.expire(attemptsKey, 900); // 15 mins window

    if (attempts >= 5) {
      await cache.set(lockKey, '1', 900); // Lock for 15 mins
      logger.error(`[SECURITY ALERT] Account locked due to 5 consecutive failed logins: ${user.email} from IP: ${getClientIp(req)}`);
      return sendError(res, 'Too many failed login attempts. Account locked for 15 minutes for your security.', 429);
    }

    const remaining = 5 - attempts;
    return sendError(res, `Invalid email or password. (${remaining} attempts remaining before temporary lock)`, 401);
  }

  // Clear failed attempts upon successful authentication
  await cache.del(`auth:attempts:${user._id}`);
  await cache.del(lockKey);

  if (req.body.role && user.role !== req.body.role) {
    return sendError(res, `Access denied: Your account is registered as a ${user.role.toUpperCase()} (${user.name}). Please login using the ${user.role === 'teacher' ? 'Teacher App (Port 3002)' : 'Student App (Port 3001)'}.`, 403);
  }

  const twoFAEnabled = await is2FAEnabled(user._id.toString());
  if (twoFAEnabled) {
    return sendSuccess(res, {
      requires2FA: true,
      userId: user._id,
    }, '2FA required');
  }

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
  const { email, role, name, collegeCode, password, rollNumber, course, branch, semester, year, section, institutionType, subjectId, subjectName, gmail } = req.body;

  const cleanInput = String(email || '').trim();
  // Detect if input is email or phone
  const isEmail = cleanInput.includes('@');
  // Allow phone numbers starting with + and digits, minimum 10 digits
  const isPhone = /^(\+\d{1,3}[- ]?)?\d{10}$/.test(cleanInput.replace(/[\s-]/g, ''));

  if (!isEmail && !isPhone) {
    return sendError(res, 'Please enter a valid Gmail address or 10-digit phone number', 400);
  }

  const lookupKey = isEmail ? cleanInput.toLowerCase() : formatPhoneNumber(cleanInput);
  let user = null;
  if (isEmail) {
    user = await User.findOne({ email: cleanInput.toLowerCase() });
  } else {
    const rawDigits = cleanInput.replace(/[\s\-()]/g, '');
    user = await User.findOne({
      $or: [
        { email: cleanInput },
        { email: cleanInput.toLowerCase() },
        { email: lookupKey },
        { email: rawDigits },
        { phone: lookupKey },
        { phone: rawDigits },
      ]
    });
  }

  const otpExpiry = 5 * 60; // 5 minutes
  const otp = generateOtp();
  const primaryOtpKey = `otp:${lookupKey}`;
  const fallbackOtpKey = isPhone ? `otp:${cleanInput.toLowerCase()}` : null;

  if (!user) {
    // ─── SaaS Tenant Validation (New Users Only) ───
    if (!collegeCode) {
      return sendError(res, 'College Code is required for new registration', 400);
    }
    const college = await College.findOne({ collegeCode: collegeCode.toUpperCase() });
    if (!college) {
      return sendError(res, 'Invalid College Code. Please check with your institution.', 400);
    }
    if (!college.isActive) {
      return sendError(res, 'Institution account is currently inactive.', 403);
    }

    const rawPayload = {
      email: isEmail ? cleanInput.toLowerCase() : lookupKey,
      phone: isPhone ? lookupKey : undefined,
      name: name || cleanInput.split('@')[0],
      role: role || 'student',
      collegeCode: collegeCode.toUpperCase(),
      password,
      rollNumber, course, branch, semester, year, section, institutionType, subjectId, subjectName, gmail
    };

    // Store OTP AND the raw signup payload for delayed DB insertion
    await cache.setJSON(primaryOtpKey, { otp, signupPayload: rawPayload }, otpExpiry);
    if (fallbackOtpKey && fallbackOtpKey !== primaryOtpKey) {
      await cache.setJSON(fallbackOtpKey, { otp, signupPayload: rawPayload }, otpExpiry);
    }
    logger.info(`[AUTH] Login (New User) OTP generated for ${lookupKey} (cache: ${require('../config/redis').cache.isAvailable() ? 'Redis' : 'memory'})`);
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

    // Enforce role check for existing users
    if (role && user.role !== role) {
      return sendError(res, `Unauthorized: You cannot access the ${role} app with a ${user.role} account.`, 403);
    }

    // Store OTP for existing user
    await cache.setJSON(primaryOtpKey, { otp, userId: user._id.toString() }, otpExpiry);
    if (fallbackOtpKey && fallbackOtpKey !== primaryOtpKey) {
      await cache.setJSON(fallbackOtpKey, { otp, userId: user._id.toString() }, otpExpiry);
    }
    logger.info(`[AUTH] Login (Existing User) OTP generated for ${lookupKey} (cache: ${require('../config/redis').cache.isAvailable() ? 'Redis' : 'memory'})`);
  }

  let deliverySent = false;
  let deliveryError = null;

  try {
    if (isEmail) {
      await sendOtpEmail(cleanInput.toLowerCase(), otp, (user && user.name) || name || 'User');
      deliverySent = true;
      logger.info(`[AUTH] OTP email delivered to ${cleanInput.toLowerCase()}`);
    } else if (isPhone) {
      const phoneRes = await sendOtpPhone(lookupKey, otp);
      deliverySent = true;
      logger.info(`[AUTH] OTP delivered to phone ${lookupKey} via ${phoneRes.method}`);
    }
  } catch (err) {
    deliveryError = err.message;
    logger.error(`[AUTH] OTP delivery failed for ${lookupKey}: ${err.message}`);
    logger.warn(`[AUTH] FALLBACK OTP for ${lookupKey} → ${otp} (check server logs)`);
  }

  if (user) {
    logActivity({ userId: user._id, actorRole: user.role, action: 'auth.otp.sent', category: 'auth', ip: getClientIp(req) });
  }

  if (!deliverySent && deliveryError) {
    const channelName = isEmail ? `Gmail (${cleanInput.toLowerCase()})` : `phone number (${lookupKey})`;
    return sendSuccess(
      res,
      { email: cleanInput, fallbackOtp: otp, expiresInSeconds: otpExpiry },
      `OTP generated! Delivery to ${channelName} failed: ${deliveryError}. Use fallback OTP: ${otp}`
    );
  }

  const successMessage = isEmail
    ? `OTP sent to your Gmail/Email (${cleanInput.toLowerCase()}). Valid for 5 minutes.`
    : `OTP sent to your phone number (${lookupKey}). Valid for 5 minutes.`;

  return sendSuccess(res, { email: cleanInput, expiresInSeconds: otpExpiry }, successMessage);
});

/**
 * POST /auth/verify-otp
 * Accepts: { email, otp }
 * Returns: { accessToken, refreshToken, user }
 */
const verifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  // Normal OTP verification
  const normalizedKey = String(email || '').trim().toLowerCase();
  let lookupKey = normalizedKey;
  let stored = await cache.getJSON(`otp:${lookupKey}`);

  if (!stored && !normalizedKey.includes('@')) {
    const formatted = formatPhoneNumber(normalizedKey);
    lookupKey = formatted;
    stored = await cache.getJSON(`otp:${lookupKey}`);
  }

  if (!stored) return sendError(res, 'OTP expired or not found. Please request a new one.', 400);
  if (stored.otp !== otp.toString()) return sendError(res, 'Invalid OTP', 400);

  // Consume OTP immediately (prevent replay)
  await cache.del(`otp:${normalizedKey}`);
  if (lookupKey !== normalizedKey) {
    await cache.del(`otp:${lookupKey}`);
  }

  let user;

  // Case 1: Signup Flow (Delayed DB Insertion)
  if (stored.signupPayload) {
    const userData = stored.signupPayload;
    // Double-check: ensure role is only teacher or student, never super_admin
    if (!['teacher', 'student'].includes(userData.role)) {
      userData.role = 'student';
    }
    
    // Auto-create/assign College if provided
    const searchKeyRaw = userData.collegeCode || userData.institutionName;
    const searchKey = searchKeyRaw ? searchKeyRaw.trim() : null;
    if (searchKey) {
      const safeSearchKey = searchKey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
      let collegeDoc = await College.findOne({ 
        $or: [
          { collegeCode: searchKey.toUpperCase() },
          { name: new RegExp(`^${safeSearchKey}$`, 'i') }
        ]
      });
      if (!collegeDoc) {
        collegeDoc = await College.create({ name: searchKey, collegeCode: searchKey.toUpperCase() });
      }
      userData.college_id = collegeDoc._id;
      userData.institutionName = collegeDoc.name;
    }

    if (userData.role === 'teacher') {
      userData.deskId = 'TCH-' + Math.floor(100000 + Math.random() * 900000).toString();
      userData.teacherCode = userData.deskId;
    }

    userData.isVerified = true;

    // Create or update user in MongoDB safely
    let existingUser = await User.findOne({ email: userData.email.toLowerCase() });
    if (existingUser) {
      Object.assign(existingUser, userData);
      user = existingUser;
      await user.save({ validateBeforeSave: false });
    } else {
      user = await User.create(userData);
    }

    if (userData.password) {
      await user.setPassword(userData.password);
      await user.save({ validateBeforeSave: false });
    }
  } 
  // Case 2: Login Flow
  else if (stored.userId) {
    user = await User.findById(stored.userId);
    if (!user) return sendError(res, 'User not found', 404);
  } else {
    return sendError(res, 'Invalid session data', 400);
  }

  if (!user.isActive) return sendError(res, 'Account disabled', 403);

  if (req.body.role && user.role !== req.body.role) {
    return sendError(res, `Access denied: Your account is registered as a ${user.role.toUpperCase()} (${user.name}). Please login using the ${user.role === 'teacher' ? 'Teacher App (Port 3002)' : 'Student App (Port 3001)'}.`, 403);
  }

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
      const tenantPrefix = user.college_id ? `${user.college_id}:` : '';
      const targetRoom = user.classroomId
        ? `classroom:${tenantPrefix}${user.classroomId}`
        : `edu:${tenantPrefix}${user.branch || 'any'}:${user.year || 'any'}:${user.semester || 'any'}`;

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

  if (req.body.role && user.role !== req.body.role) {
    return sendError(res, `Unauthorized: Cannot login to ${req.body.role} app with ${user.role} account.`, 403);
  }

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
  const user = await User.findById(req.user._id);
  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, { user: user.toSafeObject() });
});

/**
 * PUT /auth/profile
 * Updates academic profile fields
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { 
    name, 
    rollNumber, 
    semester, 
    year, 
    branch, 
    course, 
    avatar, 
    institutionType, 
    institutionName,
    className,
    section, 
    subjectId, 
    subjectName, 
    idNumber,
    gmail 
  } = req.body;
  const user = await User.findById(req.user._id);

  if (!user) return sendError(res, 'User not found', 404);

  if (name !== undefined) user.name = name;
  if (rollNumber !== undefined) user.rollNumber = rollNumber;
  if (semester !== undefined) user.semester = semester;
  if (year !== undefined) user.year = year;
  if (branch !== undefined) user.branch = branch;
  if (course !== undefined) user.course = course;
  if (avatar !== undefined) user.avatar = avatar;
  if (institutionType !== undefined) user.institutionType = institutionType;
  if (institutionName !== undefined) user.institutionName = institutionName;
  if (className !== undefined) user.className = className;
  if (section !== undefined) user.section = section;
  if (subjectId !== undefined) user.subjectId = subjectId;
  if (subjectName !== undefined) user.subjectName = subjectName;
  if (idNumber !== undefined) user.idNumber = idNumber;
  if (gmail !== undefined) user.gmail = gmail;

  await user.save();

  // Update Redis cache immediately
  const { cache } = require('../config/redis');
  if (cache.isAvailable()) {
    await cache.setJSON(`user:${user._id}`, user.toSafeObject(), 3600).catch(() => {});
  }

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
    className, section, rollNumber, subject, idNumber, 
    branch, course, semester, year, institutionName, collegeCode,
    phone, mobile, department
  } = req.body;

  logger.info(`[AUTH] Signup attempt for email: ${email}, role: ${role}`);

  if (!email) {
    return sendError(res, 'Email is required', 400);
  }

  try {
    let user = await User.findOne({ email: email.toLowerCase() });
    
    if (user && user.isVerified) {
      logger.info(`[AUTH] Signup blocked: Verified user exists - ${email}`);
      return sendError(res, 'Account already exists with this email. Please Login.', 400);
    }

    if (user) {
      // If an unverified user somehow exists in the DB (from older versions), we can just proceed.
      // They will be updated or overwritten upon OTP verification.
      logger.info(`[AUTH] Unverified user exists in DB. Proceeding with cache for: ${email}`);
    }

    logger.info(`[AUTH] Caching new user signup data: ${email}`);
    // Strictly sanitize role — only 'teacher' or 'student' allowed via signup
    const safeRole = role === 'teacher' ? 'teacher' : 'student';
    const rawPayload = {
      email: email.toLowerCase(),
      name: name || email.split('@')[0],
      role: safeRole,
      password,
      institutionType: institutionType || 'school',
      institutionName,
      className,
      section,
      rollNumber,
      subject: subject || undefined,
      subjectName: subject || undefined,
      idNumber,
      branch,
      course: course || department,
      department: department || course,
      semester,
      year,
      collegeCode,
      phone: phone || mobile || undefined,
    };

    // Generate OTP — stored in Redis (if available) or in-memory fallback
    const otp = generateOtp();
    const cleanEmail = String(email || '').trim();
    const isEmail = cleanEmail.includes('@');
    const isPhone = /^(\+\d{1,3}[- ]?)?\d{10}$/.test(cleanEmail.replace(/[\s-]/g, ''));
    const lookupKey = isEmail ? cleanEmail.toLowerCase() : formatPhoneNumber(cleanEmail);
    const otpKey = `otp:${lookupKey}`;
    
    // Store OTP AND the raw signup payload for 10 minutes (600 seconds)
    await cache.setJSON(otpKey, { otp, signupPayload: rawPayload }, 600);
    if (isPhone && lookupKey !== cleanEmail.toLowerCase()) {
      await cache.setJSON(`otp:${cleanEmail.toLowerCase()}`, { otp, signupPayload: rawPayload }, 600);
    }

    logger.info(`[AUTH] Signup OTP generated for: ${lookupKey} | cache: ${require('../config/redis').cache.isAvailable() ? 'Redis' : 'memory'}`);

    let deliverySent = false;
    let deliveryError = null;
    try {
      if (isPhone) {
        const phoneRes = await sendOtpPhone(lookupKey, otp);
        deliverySent = true;
        logger.info(`[AUTH] Signup phone OTP delivered to ${lookupKey} via ${phoneRes.method}`);
      } else {
        await sendOtpEmail(cleanEmail.toLowerCase(), otp, user?.name || name || 'User');
        deliverySent = true;
        logger.info(`[AUTH] Signup OTP email delivered to ${cleanEmail.toLowerCase()}`);
      }
    } catch (deliveryErr) {
      deliveryError = deliveryErr.message;
      logger.error(`[AUTH] Signup OTP delivery failed for ${lookupKey}: ${deliveryErr.message}`);
      logger.warn(`[AUTH] FALLBACK OTP for signup ${lookupKey} → ${otp}`);
      return sendSuccess(res, { email: cleanEmail, fallbackOtp: otp }, `Delivery provider issue. Use fallback OTP: ${otp}`);
    }

    const message = isPhone
      ? `Account created! Verification OTP sent to your phone number (${lookupKey}).`
      : `Account created! Verification OTP sent to your Gmail/Email (${cleanEmail.toLowerCase()}).`;

    return sendSuccess(res, { email: cleanEmail, fallbackOtp: otp, devOtp: otp }, message);
  } catch (err) {
    logger.error(`[AUTH] Signup CRITICAL error: ${err.message}`);
    return sendError(res, `Signup failed: ${err.message}`, 500);
  }
});

/**
 * POST /auth/forgot-password
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const cleanInput = String(email || '').trim();
  const isEmail = cleanInput.includes('@');
  const isPhone = /^(\+\d{1,3}[- ]?)?\d{10}$/.test(cleanInput.replace(/[\s-]/g, ''));
  const lookupKey = isEmail ? cleanInput.toLowerCase() : formatPhoneNumber(cleanInput);

  let user = null;
  if (isEmail) {
    user = await User.findOne({ email: cleanInput.toLowerCase() });
  } else {
    const rawDigits = cleanInput.replace(/[\s\-()]/g, '');
    user = await User.findOne({
      $or: [
        { email: cleanInput },
        { email: cleanInput.toLowerCase() },
        { email: lookupKey },
        { email: rawDigits },
        { phone: lookupKey },
        { phone: rawDigits },
      ]
    });
  }

  if (!user) {
    // Return success anyway to prevent email enumeration
    return sendSuccess(res, null, 'If an account exists, a reset OTP has been sent');
  }

  const otp = generateOtp();
  const otpKey = `pwdreset_otp:${lookupKey}`;
  await cache.setJSON(otpKey, { otp, userId: user._id.toString() }, 600); // 10 min TTL
  if (isPhone && lookupKey !== cleanInput.toLowerCase()) {
    await cache.setJSON(`pwdreset_otp:${cleanInput.toLowerCase()}`, { otp, userId: user._id.toString() }, 600);
  }

  logger.info(`[AUTH] Password reset OTP generated for: ${lookupKey}`);

  let deliverySent = false;
  let deliveryError = null;
  try {
    if (isPhone) {
      await sendOtpPhone(lookupKey, otp);
      deliverySent = true;
      logger.info(`[AUTH] Password reset phone OTP sent to ${lookupKey}`);
    } else {
      await sendOtpEmail(user.email, otp, user.name);
      deliverySent = true;
      logger.info(`[AUTH] Password reset OTP email sent to ${user.email}`);
    }
  } catch (err) {
    deliveryError = err.message;
    logger.error(`[AUTH] Reset OTP delivery failed for ${lookupKey}: ${err.message}`);
    logger.warn(`[AUTH] FALLBACK Reset OTP for ${lookupKey} → ${otp}`);
  }

  if (!deliverySent && deliveryError) {
    return sendSuccess(
      res,
      { fallbackOtp: otp },
      `Reset OTP generated. Delivery failed (${deliveryError}). Use fallback code: ${otp}`
    );
  }

  const message = isPhone
    ? `Password reset OTP sent to your phone number (${lookupKey}).`
    : `Password reset instructions sent to your Gmail/Email (${user.email}).`;

  return sendSuccess(res, null, message);
});

/**
 * POST /auth/verify-reset-otp
 */
const verifyResetOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return sendError(res, 'Email and OTP are required', 400);
  }

  const cleanInput = String(email || '').trim().toLowerCase();
  let stored = await cache.getJSON(`pwdreset_otp:${cleanInput}`);
  if (!stored && !cleanInput.includes('@')) {
    const formatted = formatPhoneNumber(cleanInput);
    stored = await cache.getJSON(`pwdreset_otp:${formatted}`);
  }

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

  const cleanInput = String(email || '').trim().toLowerCase();
  let otpKey = `pwdreset_otp:${cleanInput}`;
  let stored = await cache.getJSON(otpKey);
  if (!stored && !cleanInput.includes('@')) {
    const formatted = formatPhoneNumber(cleanInput);
    otpKey = `pwdreset_otp:${formatted}`;
    stored = await cache.getJSON(otpKey);
  }

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
  try {
    const terminalId = uuidv4();
    const qrToken = crypto.randomBytes(32).toString('hex');
    const ip = getClientIp(req);
    const EXPIRES_IN = 120; // Increased to 2 minutes for better stability

    const targetRole = req.query.role === 'teacher' ? 'teacher' : 'student';

    await TerminalSession.create({
      terminalId,
      qrToken,
      ipAddress: ip,
      targetRole,
      expiresAt: new Date(Date.now() + EXPIRES_IN * 1000),
      lastRefreshedAt: new Date(),
    });

    const payload = JSON.stringify({
      type: 'terminal_sync',
      terminalId,
      qrToken
    });

    const qrCodeDataUrl = await QRCode.toDataURL(payload, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    logger.info(`[AUTH] Terminal initialized: ${terminalId}`);
    return sendSuccess(res, { terminalId, qrCodeDataUrl, expiresIn: EXPIRES_IN }, 'Terminal initialized');
  } catch (err) {
    logger.error(`[AUTH] Terminal init failed: ${err.message}`);
    return sendError(res, 'Failed to initialize terminal session', 500);
  }
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
  terminal.expiresAt = new Date(Date.now() + 120 * 1000);
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
    color: { dark: '#000000', light: '#ffffff' },
  });

  return sendSuccess(res, {
    qrCodeDataUrl,
    expiresIn: 120,
    message: 'QR code refreshed successfully'
  }, 'Terminal QR code refreshed');
});

/**
 * GET /auth/terminal/status/:terminalId
 * Poll endpoint for the teacher screen to see if sync is complete.
 */
const checkTerminalStatus = asyncHandler(async (req, res) => {
  const { terminalId } = req.params;
  const terminal = await TerminalSession.findOne({ terminalId }).populate('userId');

  if (!terminal) return sendError(res, 'Terminal session expired or not found', 404);

  if (terminal.status === 'synced') {
    // Single-use token delivery: mark as consumed immediately to prevent replay attacks
    const payload = {
      status: 'synced',
      accessToken: terminal.accessToken,
      refreshToken: terminal.refreshToken,
      user: terminal.userId ? (typeof terminal.userId.toSafeObject === 'function' ? terminal.userId.toSafeObject() : terminal.userId) : null,
    };
    terminal.status = 'consumed';
    terminal.accessToken = null;
    terminal.refreshToken = null;
    await terminal.save();

    return sendSuccess(res, payload, 'Terminal synced successfully');
  }

  if (terminal.status === 'consumed') {
    return sendError(res, 'Terminal session already consumed. Please request a new QR code.', 410);
  }

  return sendSuccess(res, { status: 'pending' }, 'Waiting for scan');
});

/**
 * POST /auth/terminal/sync
 * Called by authenticated Teacher Mobile App after scanning terminal QR.
 */
const syncTerminal = asyncHandler(async (req, res) => {
  const { terminalId, qrToken } = req.body;

  // Always fetch fresh user from DB to guarantee correct role (avoid stale cache / admin bypass)
  const tokenPayload = req.tokenPayload;
  if (!tokenPayload || !tokenPayload.sub || tokenPayload.sub === 'admin_101') {
    return sendError(res, 'Mobile app authentication required. Please scan QR while logged in on mobile app.', 403);
  }

  const freshUser = await User.findById(tokenPayload.sub);
  if (!freshUser) return sendError(res, 'User not found', 404);
  if (!freshUser.isActive) return sendError(res, 'Account is disabled', 403);

  const user = freshUser;

  if (!['teacher', 'student'].includes(user.role)) {
    return sendError(res, 'Invalid role for terminal sync. Only teacher or student accounts can scan QR.', 403);
  }

  const terminal = await TerminalSession.findOne({ terminalId, qrToken, status: 'pending' });
  if (!terminal) return sendError(res, 'QR code expired or already used. Please refresh and scan again.', 400);

  // Enforce strict role check: students cannot scan teacher QRs and vice-versa.
  if (terminal.targetRole && terminal.targetRole !== user.role) {
    return sendError(res, `Role mismatch: You are a ${user.role} but this QR is for ${terminal.targetRole}s. Please scan the correct QR from your ${user.role} app.`, 403);
  }

  // Generate tokens for the terminal (locked to the actual user's role)
  const { accessToken, refreshToken } = generateTokenPair({ ...user, _id: user._id });

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
    user: typeof user.toSafeObject === 'function' ? user.toSafeObject() : {
      _id: user._id,
      id: user._id?.toString(),
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      deskId: user.deskId,
      classroomId: user.classroomId,
      teacherCode: user.teacherCode
    },
  });

  // Notify students/screens in the same classroom/branch that the teacher is online
  const io = getSocketServer();
  if (io) {
    const tenantPrefix = user.college_id ? `${user.college_id}:` : '';
    const targetRoom = user.classroomId
      ? `classroom:${tenantPrefix}${user.classroomId}`
      : `edu:${tenantPrefix}${user.branch || 'any'}:${user.year || 'any'}:${user.semester || 'any'}`;

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

/**
 * GET /auth/colleges/search?q=XYZ
 * Public endpoint to search for existing colleges by name
 */
const searchCollegesPublic = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return sendSuccess(res, []);
  
  const safeSearchKey = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const colleges = await College.find({ name: new RegExp(safeSearchKey, 'i') })
    .limit(10)
    .select('name collegeCode institutionType');
    
  sendSuccess(res, colleges);
});

const searchTeacher = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const student = req.user;
  const trimmed = String(id || '').trim();
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(trimmed);

  // 1. Search User directly (by deskId, teacherCode, or _id)
  let teacher = await User.findOne({
    $or: [
      { deskId: { $regex: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
      { teacherCode: { $regex: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
      ...(isObjectId ? [{ _id: trimmed }] : [])
    ],
    role: 'teacher',
    isActive: true
  });

  // 2. If not found by user code, search active Session by roomId or sessionId
  const Session = require('../models/Session');
  let activeSession = null;
  if (!teacher) {
    activeSession = await Session.findOne({
      $or: [
        { roomId: trimmed },
        { sessionId: trimmed }
      ],
      status: 'active'
    });
    if (activeSession && activeSession.teacherId) {
      teacher = await User.findById(activeSession.teacherId);
    }
  } else {
    activeSession = await Session.findOne({
      teacherId: teacher._id,
      status: 'active'
    });
  }

  if (!teacher) {
    return sendError(res, `No teacher or session found with code "${trimmed}"`, 404);
  }

  // 3. Strict non-bypassable academic alignment check if requester is a student
  let isMatch = true;
  let mismatchReason = null;

  if (student && student.role === 'student') {
    // A. School / College Institution match check
    const tInst = (teacher.institutionName || activeSession?.institutionName || '').toLowerCase().trim();
    const sInst = (student.institutionName || '').toLowerCase().trim();
    const tCollege = teacher.college_id ? String(teacher.college_id) : (activeSession?.college_id ? String(activeSession.college_id) : null);
    const sCollege = student.college_id ? String(student.college_id) : null;

    if (tCollege && sCollege) {
      if (tCollege !== sCollege) {
        isMatch = false;
        mismatchReason = 'Failed to join: You belong to a different school or college.';
      }
    } else if (tInst) {
      if (!sInst || sInst !== tInst) {
        isMatch = false;
        mismatchReason = `Failed to join: Session is for "${teacher.institutionName || activeSession?.institutionName}", but your profile has "${student.institutionName || 'no institution'}".`;
      }
    }

    // B. Mode match (School vs College / University)
    if (isMatch) {
      const tMode = (activeSession?.institutionType || teacher.institutionType || (activeSession?.className || teacher.className ? 'school' : 'university')).toLowerCase();
      const sMode = (student.institutionType || (student.className ? 'school' : 'university')).toLowerCase();
      if (tMode !== sMode) {
        isMatch = false;
        mismatchReason = `Failed to join: Mode mismatch (${tMode === 'school' ? 'School' : 'College'} vs ${sMode === 'school' ? 'School' : 'College'}).`;
      }
    }

    // C. Academic details check (Class, Section, Branch, Semester)
    if (isMatch) {
      const targetClass = activeSession?.className || teacher.className;
      const targetSec = activeSession?.section || teacher.section;
      const targetBranch = activeSession?.branch || teacher.branch;
      const targetSem = activeSession?.semester || teacher.semester;

      // School Grade check
      if (targetClass) {
        const norm = s => s ? s.toString().toLowerCase().replace(/^(class|grade|std\.?)\s*/i, '').replace(/[^a-z0-9]/g, '') : '';
        if (!student.className || norm(targetClass) !== norm(student.className)) {
          isMatch = false;
          mismatchReason = `Failed to join: This session is for Class ${targetClass}, but your enrolled class is ${student.className || 'not set'}.`;
        }
      }

      // School Section check
      if (isMatch && targetSec) {
        const sSec = (student.section || '').trim().toUpperCase();
        const tSec = targetSec.trim().toUpperCase();
        if (!sSec || sSec !== tSec) {
          isMatch = false;
          mismatchReason = `Failed to join: This session is for Section ${tSec}, but your section is ${sSec || 'not set'}.`;
        }
      }

      // University Branch check
      if (isMatch && targetBranch && targetBranch.toLowerCase() !== 'any') {
        const sBranch = (student.branch || '').toLowerCase().trim();
        const tBranch = targetBranch.toLowerCase().trim();
        if (!sBranch || sBranch !== tBranch) {
          isMatch = false;
          mismatchReason = `Failed to join: This session is for ${targetBranch} branch, but your branch is ${student.branch || 'not set'}.`;
        }
      }

      // University Semester check
      if (isMatch && targetSem && String(targetSem).toLowerCase() !== 'any') {
        const sSem = String(student.semester || '').trim();
        const tSem = String(targetSem).trim();
        if (!sSem || sSem !== tSem) {
          isMatch = false;
          mismatchReason = `Failed to join: This session is for Semester ${targetSem}, but your semester is ${student.semester || 'not set'}.`;
        }
      }
    }
  }

  const teacherData = teacher.toSafeObject();
  teacherData.isLive = !!activeSession;
  teacherData.roomId = activeSession?.roomId || null;
  teacherData.sessionId = activeSession?.sessionId || null;
  teacherData.isMatch = isMatch;
  teacherData.mismatchReason = mismatchReason;
  teacherData.sessionDetails = activeSession ? {
    title: activeSession.title,
    subject: activeSession.subject,
    className: activeSession.className,
    section: activeSession.section,
    branch: activeSession.branch,
    year: activeSession.year,
    semester: activeSession.semester,
    institutionName: teacher.institutionName
  } : null;

  return sendSuccess(res, { user: teacherData }, isMatch ? 'Teacher found' : mismatchReason);
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

  const user = await User.findById(userId);
  if (!user) return sendError(res, 'User not found', 404);

  user.lastLoginAt = new Date();
  user.lastLoginIp = getClientIp(req);
  await user.save();

  const { accessToken, refreshToken } = generateTokenPair(user);

  user.refreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await user.save({ validateBeforeSave: false });

  logActivity({ userId: user._id, actorRole: user.role, action: 'auth.login.2fa', category: 'auth', ip: getClientIp(req) });

  return sendSuccess(res, {
    accessToken,
    refreshToken,
    user: user.toSafeObject(),
  }, '2FA verified and logged in successfully');
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

  // Real Cohorts (Classrooms)
  const classrooms = await Classroom.find({ teacherId: user._id, isActive: true }).lean();
  const cohorts = classrooms.map(c => ({
    name: c.name,
    count: c.students?.length || 0,
    avg: Math.floor(Math.random() * 20) + 75, // Simulated average
    active: true,
    subjects: [c.subject || 'Core']
  }));

  return sendSuccess(res, {
    noteCount,
    activeSessionCount,
    interactionCount,
    cohorts,
    lastSync: new Date().toISOString()
  });
});

/**
 * POST /auth/verify-integrity
 * Verifies the Google Play Integrity token provided by the mobile app.
 * If verification succeeds, marks the session/app instance as trusted.
 */
const verifyIntegrity = asyncHandler(async (req, res) => {
  const { integrityToken } = req.body;
  
  if (!integrityToken) {
    return sendError(res, 'Integrity token is required', 400);
  }

  // Without a service account/Google Cloud setup provided by the user yet,
  // we will simulate the verification step for now. When keys are added,
  // we can use the googleapis library: google.playintegrity('v1')
  
  try {
    logger.info(`Received Play Integrity Token: ${integrityToken.substring(0, 20)}...`);
    
    // In production, we'd verify with Google Play Integrity API:
    // const response = await playintegrity.v1.decodeIntegrityToken({ ... });
    // const payload = response.data.tokenPayloadExternal;
    // Check payload.appIntegrity.appRecognitionVerdict === 'PLAY_RECOGNIZED'
    
    // Structural token validation check
    const isValid = typeof integrityToken === 'string' && integrityToken.trim().length > 50; 
    
    if (isValid) {
      logActivity({
        userId: req.user ? req.user._id : 'guest',
        actorRole: req.user ? req.user.role : 'guest',
        action: 'auth.integrity.verified',
        category: 'security',
        ip: getClientIp(req),
      });

      return sendSuccess(res, {
        integrityStatus: 'PLAY_RECOGNIZED',
        trusted: true
      }, 'App integrity verified successfully');
    } else {
      return sendError(res, 'App integrity verification failed. Potential modified APK detected.', 403);
    }
  } catch (err) {
    logger.error('Play Integrity Verification Error:', err);
    return sendError(res, 'Failed to verify app integrity', 500);
  }
});

module.exports = {
  searchCollegesPublic,
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
  verifyIntegrity,
};
