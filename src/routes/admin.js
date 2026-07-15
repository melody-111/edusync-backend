'use strict';

const express = require('express');
const router = express.Router();

const {
  getGlobalStats,
  getAllUsers,
  getAllSessions,
  updateUserStatus,
  updateUserRole,
  createCollege,
  getColleges,
  toggleCollegeBlock,
  sendUserNotification,
  getSystemStats,
  getUserActivities,
  getSystemLogs,
  getInstitutionHierarchy,
  blockUser,
  unblockUser,
  getUserDetails,
} = require('../controllers/adminController');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { sendError } = require('../utils/helpers');

// Admin-only guard: only the designated admin email or super_admin role can access
const requireAdmin = (req, res, next) => {
  if (!req.user || (req.user.role !== 'super_admin' && req.user.email !== process.env.ADMIN_EMAIL)) {
    return sendError(res, 'Administrator access required', 403);
  }
  next();
};

router.use(authenticate);
router.use(apiLimiter);
router.use(requireAdmin);

// GET  /admin/stats              — global dashboard stats
router.get('/stats', getGlobalStats);

// GET  /admin/logs               — system wide audit logs
router.get('/logs', getSystemLogs);

// GET  /admin/system-stats       — hardware usage (CPU/RAM)
router.get('/system-stats', getSystemStats);

// GET  /admin/users              — all users (filter: ?role=teacher&isActive=true)
router.get('/users', getAllUsers);

// GET  /admin/sessions           — all sessions (filter: ?status=active)
router.get('/sessions', getAllSessions);

// PUT  /admin/users/:id/status   — activate or deactivate a user { isActive: true/false }
router.put('/users/:id/status', updateUserStatus);

// PUT  /admin/users/:id/role     — change user role { role: 'teacher'|'student' }
router.put('/users/:id/role', updateUserRole);

// POST /admin/users/:id/notify   — send notification/warning to user
router.post('/users/:id/notify', sendUserNotification);

// GET  /admin/users/:id/activities — get PDF/file activities for user
router.get('/users/:id/activities', getUserActivities);

// ─── College Routes ─────────────────────────────────────────────────────────
// POST /admin/colleges             — create new college
router.post('/colleges', createCollege);

// GET  /admin/colleges             — list all colleges
router.get('/colleges', getColleges);

// PUT  /admin/colleges/:id/block   — block/unblock a college
router.put('/colleges/:id/block', toggleCollegeBlock);

// GET  /admin/hierarchy            — data grouped by College -> Teachers/Students
router.get('/hierarchy', getInstitutionHierarchy);

// POST /admin/users/:id/block      — block user
router.post('/users/:id/block', blockUser);

// POST /admin/users/:id/unblock    — unblock user
router.post('/users/:id/unblock', unblockUser);

// GET  /admin/users/:id/details    — get comprehensive user details + history
router.get('/users/:id/details', getUserDetails);

module.exports = router;
