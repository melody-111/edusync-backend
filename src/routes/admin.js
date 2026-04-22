'use strict';

const express = require('express');
const router = express.Router();

const {
  getGlobalStats,
  getAllUsers,
  getAllSessions,
  updateUserStatus,
  updateUserRole,
} = require('../controllers/adminController');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { sendError } = require('../utils/helpers');

// Admin-only guard: only the designated admin email can access
const requireAdmin = (req, res, next) => {
  if (req.user.email !== process.env.ADMIN_EMAIL) {
    return sendError(res, 'Administrator access required', 403);
  }
  next();
};

router.use(authenticate);
router.use(apiLimiter);
router.use(requireAdmin);

// GET  /admin/stats              — global dashboard stats
router.get('/stats', getGlobalStats);

// GET  /admin/users              — all users (filter: ?role=teacher&isActive=true)
router.get('/users', getAllUsers);

// GET  /admin/sessions           — all sessions (filter: ?status=active)
router.get('/sessions', getAllSessions);

// PUT  /admin/users/:id/status   — activate or deactivate a user { isActive: true/false }
router.put('/users/:id/status', updateUserStatus);

// PUT  /admin/users/:id/role     — change user role { role: 'teacher'|'student' }
router.put('/users/:id/role', updateUserRole);

module.exports = router;
