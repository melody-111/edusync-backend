'use strict';

const SyncQueue = require('../models/SyncQueue');
const StrokeBatch = require('../models/StrokeBatch');
const Page = require('../models/Page');
const { compressStrokes } = require('../utils/compression');
const logger = require('../utils/logger');

const MAX_CONCURRENT = 5;

/**
 * Process pending sync queue items for a user
 * Called when user comes back online
 */
const processSyncQueue = async (userId) => {
  // Get pending items ordered by sequence
  const items = await SyncQueue.find({
    userId,
    status: 'pending',
    retryCount: { $lt: 5 },
  })
    .sort({ sequence: 1, clientTimestamp: 1 })
    .limit(100);

  if (items.length === 0) return;

  logger.info(`Processing ${items.length} sync items for user ${userId}`);

  // Process in batches to avoid overwhelming DB
  for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
    const batch = items.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(batch.map((item) => processSyncItem(item)));
  }
};

const processSyncItem = async (item) => {
  await SyncQueue.findByIdAndUpdate(item._id, {
    status: 'processing',
    lastAttemptAt: new Date(),
  });

  try {
    const payload = JSON.parse(item.payload);

    switch (item.operation) {
      case 'stroke_batch':
        await handleStrokeBatch(item, payload);
        break;
      case 'note_update':
        await handleNoteUpdate(item, payload);
        break;
      case 'page_create':
        await handlePageCreate(item, payload);
        break;
      case 'canvas_snapshot':
        await handleSnapshot(item, payload);
        break;
      default:
        logger.warn(`Unknown sync operation: ${item.operation}`);
    }

    await SyncQueue.findByIdAndUpdate(item._id, {
      status: 'synced',
      syncedAt: new Date(),
    });
  } catch (err) {
    logger.error(`Sync item ${item._id} failed: ${err.message}`);
    await SyncQueue.findByIdAndUpdate(item._id, {
      status: item.retryCount + 1 >= 5 ? 'failed' : 'pending',
      $inc: { retryCount: 1 },
      errorMessage: err.message,
    });
  }
};

const handleStrokeBatch = async (item, payload) => {
  const page = await Page.findOneAndUpdate(
    { sessionId: item.sessionId, ownerId: item.userId, pageNumber: payload.pageNumber || 1 },
    { $setOnInsert: { ownerRole: 'student' } },
    { upsert: true, new: true }
  );

  const compressed = await compressStrokes(payload.strokes || []);
  await StrokeBatch.create({
    sessionId: item.sessionId,
    pageId: page._id,
    ownerId: item.userId,
    ownerRole: 'student',
    strokesData: compressed,
    strokeCount: (payload.strokes || []).length,
    batchIndex: payload.batchIndex || 0,
    compressed: true,
  });
};

const handleNoteUpdate = async (item, payload) => {
  const Page_model = require('../models/Page');
  await Page_model.findOneAndUpdate(
    { _id: payload.pageId, ownerId: item.userId },
    { title: payload.title, updatedAt: new Date() }
  );
};

const handlePageCreate = async (item, payload) => {
  await Page.findOneAndUpdate(
    {
      sessionId: item.sessionId,
      ownerId: item.userId,
      pageNumber: payload.pageNumber,
    },
    {
      ownerRole: 'student',
      backgroundType: payload.backgroundType || 'blank',
    },
    { upsert: true }
  );
};

const handleSnapshot = async (item, payload) => {
  await Page.findOneAndUpdate(
    { _id: payload.pageId, ownerId: item.userId },
    { canvasSnapshot: payload.snapshotDataUrl, snapshotUpdatedAt: new Date() }
  );
};

module.exports = { processSyncQueue };
