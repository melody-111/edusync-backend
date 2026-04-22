'use strict';

const express = require('express');
const router = express.Router();

const {
  getNotifications, markAsRead, deleteNotification,
} = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');

router.use(authenticate);

router.get('/', getNotifications);
router.patch('/read', [body('notificationIds').optional().isArray()], validate, markAsRead);
router.delete('/:id', deleteNotification);

module.exports = router;
