'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');
let MongoMemoryServer;
try {
  MongoMemoryServer = require('mongodb-memory-server').MongoMemoryServer;
} catch {
  // Ignored in prod
}

const MONGO_OPTIONS = {
  maxPoolSize: 100, // Increased for high concurrency
  minPoolSize: 10,  // Increased for faster initial response
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  w: 'majority',
};


let retryCount = 0;
const MAX_RETRIES = 5;
let memoryServer = null;
let isConnecting = false;

const connectDB = async () => {
  if (isConnecting) {
    logger.info('MongoDB connection already in progress, skipping...');
    return;
  }
  
  isConnecting = true;
  
  try {
    let uri = process.env.MONGODB_URI;
    const conn = await mongoose.connect(uri, MONGO_OPTIONS);
    retryCount = 0;
    isConnecting = false;
    logger.info(`mongodb connected succesfully (${conn.connection.host})`);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production' && MongoMemoryServer) {
        logger.warn(`Local MongoDB connection failed: ${err.message}. Initializing Memory Server fallback...`);
        try {
          await mongoose.disconnect(); // Clean state
        } catch {}
        
        if (!memoryServer) {
            memoryServer = await MongoMemoryServer.create();
            process.env.MONGODB_URI = memoryServer.getUri();
        }
        await mongoose.connect(process.env.MONGODB_URI, MONGO_OPTIONS);
        isConnecting = false;
        logger.info(`MongoDB connected to fallback Memory Server at ${process.env.MONGODB_URI}`);
        return;
    }

    retryCount += 1;
    isConnecting = false;
    logger.error(`MongoDB connection error (attempt ${retryCount}): ${err.message}`);
    if (retryCount < MAX_RETRIES) {
      const delay = Math.min(1000 * 2 ** retryCount, 30000);
      logger.info(`Retrying MongoDB connection in ${delay / 1000}s...`);
      setTimeout(connectDB, delay);
    } else {
      logger.error('Max MongoDB retries reached. Exiting.');
      process.exit(1);
    }
  }
};

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected. Attempting reconnect...');
  if (!memoryServer && !isConnecting) connectDB(); // Only auto-reconnect if not memory db and not already connecting
});

mongoose.connection.on('error', (err) => {
  logger.error(`MongoDB error: ${err.message}`);
});

module.exports = connectDB;
