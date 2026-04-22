'use strict';

const { body } = require('express-validator');
const Notification = require('../models/Notification');
const { asyncHandler, sendSuccess, sendError, paginate } = require('../utils/helpers');

// ─── Get Notifications ─────────────────────────────────────────────────────────
const getNotifications = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, unreadOnly } = req.query;
  const query = { userId: req.user._id };
  if (unreadOnly === 'true') query.isRead = false;

  const { docs: notifications, pagination } = await paginate(Notification, query, {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    sort: { createdAt: -1 },
  });

  const unreadCount = await Notification.countDocuments({ userId: req.user._id, isRead: false });

  return sendSuccess(res, { notifications, unreadCount, pagination });
});

// ─── Mark as Read ──────────────────────────────────────────────────────────────
const markAsRead = asyncHandler(async (req, res) => {
  const { notificationIds } = req.body;

  if (!notificationIds || notificationIds.length === 0) {
    // Mark all as read
    await Notification.updateMany(
      { userId: req.user._id, isRead: false },
      { isRead: true, readAt: new Date() }
    );
  } else {
    await Notification.updateMany(
      { _id: { $in: notificationIds }, userId: req.user._id },
      { isRead: true, readAt: new Date() }
    );
  }

  return sendSuccess(res, null, 'Notifications marked as read');
});

// ─── Delete Notification ───────────────────────────────────────────────────────
const deleteNotification = asyncHandler(async (req, res) => {
  await Notification.deleteOne({ _id: req.params.id, userId: req.user._id });
  return sendSuccess(res, null, 'Notification deleted');
});

// ─── Create notification (internal service) ────────────────────────────────────
const createNotification = async ({ userId, sessionId, type, title, body, data }) => {
  return Notification.create({ userId, sessionId, type, title, body, data });
};

module.exports = { getNotifications, markAsRead, deleteNotification, createNotification };
