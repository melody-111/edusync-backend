'use strict';

const { body, param, query } = require('express-validator');
const Device = require('../models/Device');
const { asyncHandler, sendSuccess, sendError, paginate } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');

// ─── Register / Upsert Device ─────────────────────────────────────────────────
const registerDevice = asyncHandler(async (req, res) => {
  const { deviceId, deviceType, deviceName, platform, userAgent, fcmToken } = req.body;
  const user = req.user;

  // Validate device type matches user role
  const allowedTypes = {
    teacher: ['teacher-device', 'mobile-device'],
    student: ['student-desk', 'mobile-device'],
  };
  if (!allowedTypes[user.role].includes(deviceType)) {
    return sendError(res, `Device type '${deviceType}' not allowed for role '${user.role}'`, 403);
  }

  const device = await Device.findOneAndUpdate(
    { deviceId },
    {
      userId: user._id,
      deviceType,
      deviceName: deviceName || 'Unknown Device',
      platform: platform || null,
      userAgent: userAgent || req.headers['user-agent'] || null,
      fcmToken: fcmToken || null,
      lastSeenAt: new Date(),
      isActive: true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logActivity({ userId: user._id, actorRole: user.role, action: 'device.register', category: 'system', details: { deviceId, deviceType } });

  return sendSuccess(res, { device }, 'Device registered', 201);
});

// ─── Get My Devices ────────────────────────────────────────────────────────────
const getMyDevices = asyncHandler(async (req, res) => {
  const devices = await Device.find({ userId: req.user._id, isActive: true })
    .populate('activeSessionId', 'title status startedAt')
    .lean();
  return sendSuccess(res, { devices });
});

// ─── Get Single Device ─────────────────────────────────────────────────────────
const getDevice = asyncHandler(async (req, res) => {
  const device = await Device.findOne({
    deviceId: req.params.deviceId,
    userId: req.user._id,
  }).lean();
  if (!device) return sendError(res, 'Device not found', 404);
  return sendSuccess(res, { device });
});

// ─── Update Device Status ─────────────────────────────────────────────────────
const updateDeviceStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const device = await Device.findOneAndUpdate(
    { deviceId: req.params.deviceId, userId: req.user._id },
    { status, lastSeenAt: new Date() },
    { new: true }
  );
  if (!device) return sendError(res, 'Device not found', 404);
  return sendSuccess(res, { device }, 'Status updated');
});

// ─── Deactivate Device ─────────────────────────────────────────────────────────
const deactivateDevice = asyncHandler(async (req, res) => {
  const device = await Device.findOneAndUpdate(
    { deviceId: req.params.deviceId, userId: req.user._id },
    { isActive: false, status: 'offline', activeSessionId: null },
    { new: true }
  );
  if (!device) return sendError(res, 'Device not found', 404);
  return sendSuccess(res, null, 'Device deactivated');
});

// ─── Validation ────────────────────────────────────────────────────────────────
const registerDeviceValidation = [
  body('deviceId').notEmpty().isString().trim().withMessage('deviceId required'),
  body('deviceType')
    .isIn(['teacher-device', 'student-desk', 'mobile-device'])
    .withMessage('Invalid deviceType'),
  body('platform').optional().isIn(['ios', 'android', 'web', 'desktop']),
];

const deviceIdParamValidation = [
  param('deviceId').notEmpty().withMessage('Device ID required'),
];

const updateDeviceStatusValidation = [
  param('deviceId').notEmpty().withMessage('Device ID required'),
  body('status').isIn(['online', 'offline', 'busy', 'away']).withMessage('Invalid status'),
];

module.exports = {
  registerDevice,
  getMyDevices,
  getDevice,
  updateDeviceStatus,
  deactivateDevice,
  registerDeviceValidation,
  deviceIdParamValidation,
  updateDeviceStatusValidation,
};
