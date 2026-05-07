'use strict';

require('dotenv').config();

const http = require('http');
const createApp = require('./app');
const connectDB = require('./config/db');
const { connectRedis } = require('./config/redis');
const { initSocketServer } = require('./socket/server');
const logger = require('./utils/logger');

const PORT = parseInt(process.env.PORT, 10) || 5000;

const start = async () => {
  // ─── Connect Infrastructure ────────────────────────────────────────────────
  await connectDB();
  await connectRedis();

  // ─── Verify SMTP Config ────────────────────────────────────────────────────
  const { verifyEmailConfig } = require('./utils/email');
  const isSmtpValid = await verifyEmailConfig();
  if (!isSmtpValid) {
    logger.warn('SMTP Configuration is invalid. Emails will not be sent.');
  } else {
    logger.info('SMTP Configuration verified successfully.');
  }

  // ─── Create Express App + HTTP Server ─────────────────────────────────────
  const app = createApp();
  const httpServer = http.createServer(app);

  // ─── Initialize Socket.io ─────────────────────────────────────────────────
  await initSocketServer(httpServer);


  // ─── Start listening ──────────────────────────────────────────────────────
  httpServer.listen(PORT, '0.0.0.0', () => {
    logger.info(`backend running on port ${PORT}`);
    logger.info(`Local IP Access: http://127.0.0.1:${PORT}`);
    logger.info(`Network Access: http://192.168.18.109:${PORT}`);
  });

  // ─── Kiosk Hardware: Memory usage monitor ──────────────────────────────────
  setInterval(() => {
    const usage = process.memoryUsage();
    logger.info(`[Kiosk.Perf] Heap: ${Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100}MB / RSS: ${Math.round(usage.rss / 1024 / 1024 * 100) / 100}MB`);
  }, 300000); // Every 5 minutes

  // ─── Daily Cleanup Job: Exports & Logs ──────────────────────────────────────
  const { cleanupOldFiles } = require('./utils/cleanup');
  const path = require('path');
  setInterval(async () => {
    logger.info('[Cleanup] Running scheduled cleanup...');
    await cleanupOldFiles(path.join(process.cwd(), 'exports'), 14); // 14 days
    await cleanupOldFiles(path.join(process.cwd(), 'logs'), 30);    // 30 days
  }, 86400000); // Every 24 hours


  // ─── Graceful Shutdown ────────────────────────────────────────────────────
  const gracefulShutdown = async (signal) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    httpServer.close(async () => {
      try {
        const mongoose = require('mongoose');
        await mongoose.connection.close();
        logger.info('MongoDB connection closed');

        const { getRedisClient } = require('./config/redis');
        const redisClient = getRedisClient();
        if (redisClient) await redisClient.quit();
        logger.info('Redis connection closed');

        logger.info('Graceful shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error(`Shutdown error: ${err.message}`);
        process.exit(1);
      }
    });

    // Force exit after 15 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // ─── Unhandled Promise Rejections ─────────────────────────────────────────
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', { reason, promise });
  });

  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });
};

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});
