'use strict';

const { body } = require('express-validator');
const SyncQueue = require('../models/SyncQueue');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');
const { processSyncQueue } = require('../services/syncService');
const logger = require('../utils/logger');

// ─── Push Offline Items to Queue ───────────────────────────────────────────────
const pushSyncItems = asyncHandler(async (req, res) => {
  const { items } = req.body;
  const user = req.user;

  if (!Array.isArray(items) || items.length === 0) {
    return sendError(res, 'items array required', 400);
  }

  const MAX_BATCH = 100;
  if (items.length > MAX_BATCH) {
    return sendError(res, `Max ${MAX_BATCH} items per batch`, 400);
  }

  const docs = items.map((item, i) => ({
    userId: user._id,
    deviceId: item.deviceId || null,
    sessionId: item.sessionId || null,
    operation: item.operation,
    payload: JSON.stringify(item.payload),
    status: 'pending',
    clientTimestamp: new Date(item.clientTimestamp || Date.now()),
    sequence: item.sequence || i,
  }));

  const created = await SyncQueue.insertMany(docs, { ordered: false });

  // Trigger async processing (non-blocking)
  processSyncQueue(user._id.toString()).catch((err) =>
    logger.error(`Sync processing error: ${err.message}`)
  );

  return sendSuccess(res, {
    accepted: created.length,
    total: items.length,
  }, 'Sync items queued');
});

// ─── Get Sync Status ───────────────────────────────────────────────────────────
const getSyncStatus = asyncHandler(async (req, res) => {
  const counts = await SyncQueue.aggregate([
    { $match: { userId: req.user._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const statusMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));
  return sendSuccess(res, {
    pending: statusMap.pending || 0,
    processing: statusMap.processing || 0,
    synced: statusMap.synced || 0,
    failed: statusMap.failed || 0,
  });
});

// ─── Retry Failed Items ────────────────────────────────────────────────────────
const retryFailed = asyncHandler(async (req, res) => {
  await SyncQueue.updateMany(
    { userId: req.user._id, status: 'failed', retryCount: { $lt: 5 } },
    { status: 'pending', lastAttemptAt: null }
  );

  processSyncQueue(req.user._id.toString()).catch(logger.error);
  return sendSuccess(res, null, 'Failed items queued for retry');
});

// ─── Validation ────────────────────────────────────────────────────────────────
const pushSyncValidation = [
  body('items').isArray({ min: 1 }).withMessage('items array required'),
  body('items.*.operation')
    .isIn(['stroke_batch', 'note_update', 'page_create', 'file_upload', 'canvas_snapshot'])
    .withMessage('Invalid operation type'),
  body('items.*.payload').notEmpty().withMessage('payload required'),
  body('items.*.clientTimestamp').optional().isISO8601(),
];

module.exports = { pushSyncItems, getSyncStatus, retryFailed, pushSyncValidation };
