'use strict';

const { Queue } = require('bullmq');
const { createRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

let pdfQueue = null;

try {
  const connection = createRedisClient();
  if (connection) {
    pdfQueue = new Queue('pdf-generation', { connection });
    pdfQueue.on('error', (err) => {
      logger.warn(`[PDF Queue] Redis connection notice: ${err.message}`);
    });
  } else {
    logger.info('[PDF Queue] Redis connection not configured — background queue inactive.');
  }
} catch (err) {
  logger.warn(`[PDF Queue] Initialization skipped: ${err.message}`);
}

/**
 * Adds a new PDF generation job to the queue
 * @param {Object} data - job data (sessionId, canvasData, ownerId)
 */
const addPdfJob = async (data) => {
  if (!pdfQueue) {
    logger.debug('[PDF Queue] Queue not active, skipping enqueue.');
    return;
  }
  try {
    await pdfQueue.add('generate-pdf', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: {
        age: 24 * 3600, // keep failed jobs for 24 hours
      }
    });
  } catch (err) {
    logger.warn(`[PDF Queue] Could not add job: ${err.message}`);
  }
};

module.exports = { pdfQueue, addPdfJob };
