'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const passport = require('passport');
const path = require('path');

const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const {
  requestId,
  generalLimiter,
  authLimiter,
  ipWhitelist
} = require('./middleware/security');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const { sstiGuard } = require('./middleware/sstiSanitizer');
const setupSwagger = require('./config/swagger');

const logger = require('./utils/logger');


// ─── Route Modules ─────────────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const deviceRoutes = require('./routes/devices');
const fileRoutes = require('./routes/files');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const syncRoutes = require('./routes/sync');
const classroomRoutes = require('./routes/classrooms');
const notesRoutes = require('./routes/notes');
const adminRoutes = require('./routes/admin');
const folderRoutes = require('./routes/folders');
const freeStudyRoutes = require('./routes/freeStudy'); // 🆕 Free Study Mode
const youtubeRoutes = require('./routes/youtube'); // 🆕 YouTube Search
const examRoutes = require('./routes/exams'); // 🆕 Exam Mode

const createApp = () => {
  const app = express();


  // ─── Setup Swagger Docs ────────────────────────────────────────────────────────
  setupSwagger(app);

  // ─── Security ───────────────────────────────────────────────────────────────
  app.use(helmet({
    crossOriginEmbedderPolicy: false, // Disabling because of QR/external image data
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow cross-origin requests for resources
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Allow OAuth popups
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        connectSrc: ["'self'", 'wss:', 'ws:', 'https:', 'http:', process.env.CLIENT_URL || 'http://localhost:3000'],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // unsafe-eval may be needed for some PDF libs
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        frameAncestors: ["'none'"], // Prevent clickjacking
        objectSrc: ["'none'"],
      },
    },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    ieNoOpen: true,
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    xssFilter: true,
  }));

  app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-API-Key', 'X-Admin-Secret'],
  }));

  // ─── Trust Proxy ────────────────────────────────────────────────────────────
  // Required for Cloudflare IP restoration and DDoS protection to function correctly via the limiter
  app.set('trust proxy', 1);

  // ─── Request ID for Audit Logging ─────────────────────────────────────────────
  app.use(requestId);

  // ─── General Rate Limiting ───────────────────────────────────────────────────
  app.use(generalLimiter);

  // ─── Body Parsing & LPDoS Mitigation ─────────────────────────────────────────
  // Specific routes that require higher payloads for whiteboard strokes / attachments
  app.use('/user/notes', express.json({ limit: '25mb' }));
  app.use('/files', express.json({ limit: '25mb' }));

  // Global strict body limit to prevent Memory Exhaustion & LPDoS
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // ─── Data Sanitization & Input Validation ────────────────────────────────────
  // Protect against NoSQL Injection (recursively cleans prohibited keys)
  app.use(mongoSanitize({ replaceWith: '_' }));

  // Protect against Server Side Template Injection (SSTI) & Code Injection
  app.use(sstiGuard);

  // Protect against XSS
  app.use(xss());

  // Protect against HTTP Parameter Pollution (HPP) attacks
  app.use(hpp());

  // ─── Compression ─────────────────────────────────────────────────────────────
  app.use(compression());

  // ─── Logging ─────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
      stream: { write: (msg) => logger.info(msg.trim()) },
    }));
  }

  // ─── Passport ────────────────────────────────────────────────────────────────
  app.use(passport.initialize());

  // ─── Static File Serving ─────────────────────────────────────────────────────
  const staticOptions = { maxAge: '1d', etag: true };
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), staticOptions));
  app.use('/exports', express.static(path.join(process.cwd(), 'exports'), staticOptions));

  // ─── Health Check ─────────────────────────────────────────────────────────────
  app.get('/health', async (req, res) => {
    const mongoose = require('mongoose');
    const { cache } = require('./config/redis');

    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    const redisStatus = cache.isAvailable() ? 'connected' : 'disconnected';

    // PostgreSQL is optional for health check
    let postgresStatus = 'not_configured';
    if (process.env.POSTGRES_URI) {
      try {
        const { pool: postgresPool } = require('./config/postgres');
        await postgresPool.query('SELECT 1');
        postgresStatus = 'connected';
      } catch {
        postgresStatus = 'disconnected';
      }
    }

    // Server is healthy as long as MongoDB is connected.
    // Redis is optional — if not configured (e.g. no Redis on Render free plan),
    // we still return 200 so health checks pass and the server stays up.
    const status = dbStatus === 'connected' ? 'healthy' : 'degraded';

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      services: {
        mongodb: dbStatus,
        redis: redisStatus,
        postgres: postgresStatus
      }
    });
  });


  // ─── API Routes ───────────────────────────────────────────────────────────────
  // Auth routes (individual routes have specific limiters)
  app.use('/auth', authRoutes);
  app.use('/api/auth', authRoutes);

  // Session routes with API limiter
  app.use('/session', apiLimiter, sessionRoutes);
  app.use('/api/session', apiLimiter, sessionRoutes);

  // Device routes with API limiter
  app.use('/devices', apiLimiter, deviceRoutes);
  app.use('/api/devices', apiLimiter, deviceRoutes);

  // File routes with API limiter
  app.use('/files', apiLimiter, fileRoutes);
  app.use('/api/files', apiLimiter, fileRoutes);

  // Mobile notes API with API limiter
  app.use('/user/notes', apiLimiter, notesRoutes);
  app.use('/api/user/notes', apiLimiter, notesRoutes);

  // AI routes with API limiter
  app.use('/ai', apiLimiter, aiRoutes);
  app.use('/api/ai', apiLimiter, aiRoutes);

  // Notification routes with API limiter
  app.use('/notifications', apiLimiter, notificationRoutes);
  app.use('/api/notifications', apiLimiter, notificationRoutes);

  // Sync routes with API limiter
  app.use('/sync', apiLimiter, syncRoutes);
  app.use('/api/sync', apiLimiter, syncRoutes);

  // Classroom routes with API limiter
  app.use('/classrooms', apiLimiter, classroomRoutes);
  app.use('/api/classrooms', apiLimiter, classroomRoutes);

  // Admin routes with IP whitelisting (configure allowed IPs in .env)
  const adminAllowedIPs = process.env.ADMIN_ALLOWED_IPS ? process.env.ADMIN_ALLOWED_IPS.split(',') : [];
  if (adminAllowedIPs.length > 0) {
    app.use('/admin', ipWhitelist(adminAllowedIPs), adminRoutes);
    app.use('/api/admin', ipWhitelist(adminAllowedIPs), adminRoutes);
  } else {
    app.use('/admin', adminRoutes);
    app.use('/api/admin', adminRoutes);
  }

  // Folder routes with API limiter
  app.use('/folders', apiLimiter, folderRoutes);
  app.use('/api/folders', apiLimiter, folderRoutes);

  // 🆕 Free Study Mode
  app.use('/', freeStudyRoutes);

  // 🆕 YouTube Search
  app.use('/youtube', apiLimiter, youtubeRoutes);
  app.use('/api/youtube', apiLimiter, youtubeRoutes);

  // 🆕 Exam Mode
  app.use('/exams', apiLimiter, examRoutes);
  app.use('/api/exams', apiLimiter, examRoutes);

  // ─── 404 + Error Handlers ─────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

module.exports = createApp;
