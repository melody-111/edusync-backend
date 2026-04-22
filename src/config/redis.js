'use strict';

const Redis = require('ioredis');
const logger = require('../utils/logger');

let redisClient = null;
let _isAvailable = false;

// ─── Connect to Redis ─────────────────────────────────────────────────────────
const connectRedis = async () => {
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
    logger.warn('[Redis] No REDIS_URL or REDIS_HOST configured. Using in-memory fallback cache.');
    return;
  }

  try {
    const config = process.env.REDIS_URL
      ? process.env.REDIS_URL
      : {
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: parseInt(process.env.REDIS_PORT, 10) || 6379,
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: 3,
          connectTimeout: 5000,
          retryStrategy(times) {
            if (times > 5) return null; // Stop retrying after 5 attempts
            return Math.min(times * 300, 2000);
          },
        };

    redisClient = new Redis(config);

    await redisClient.ping(); // Verify connection
    _isAvailable = true;
    logger.info('[Redis] Connected successfully.');

    redisClient.on('error', (err) => {
      _isAvailable = false;
      logger.error(`[Redis] Error: ${err.message}`);
    });

    redisClient.on('ready', () => {
      _isAvailable = true;
      logger.info('[Redis] Connection restored and ready.');
    });

    redisClient.on('reconnecting', () => {
      logger.warn('[Redis] Reconnecting...');
    });

  } catch (err) {
    logger.warn(`[Redis] Connection failed: ${err.message}. Falling back to in-memory cache.`);
    redisClient = null;
    _isAvailable = false;
  }
};

// ─── In-Memory Fallback ───────────────────────────────────────────────────────
// Used when Redis is not configured or unavailable.
// NOTE: This does NOT work across multiple server instances — for single-server dev only.
const _mockCache = new Map();

const _mockGet = (key) => {
  const data = _mockCache.get(key);
  if (!data) return null;
  if (data.exp !== null && data.exp < Date.now()) {
    _mockCache.delete(key);
    return null;
  }
  return data.val;
};

// ─── Unified Cache API ────────────────────────────────────────────────────────
// All methods work with real Redis OR in-memory fallback transparently.
const cache = {
  isAvailable: () => _isAvailable,

  // ── Key Exists ──
  exists: async (key) => {
    if (redisClient && _isAvailable) return await redisClient.exists(key);
    return _mockGet(key) !== null ? 1 : 0;
  },

  // ── String SET/GET (JSON) ──
  setJSON: async (key, val, ttlSeconds) => {
    const str = JSON.stringify(val);
    if (redisClient && _isAvailable) {
      if (ttlSeconds) await redisClient.setex(key, ttlSeconds, str);
      else await redisClient.set(key, str);
    } else {
      _mockCache.set(key, { val: str, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    }
  },

  getJSON: async (key) => {
    if (redisClient && _isAvailable) {
      const val = await redisClient.get(key);
      return val ? JSON.parse(val) : null;
    }
    const raw = _mockGet(key);
    return raw ? JSON.parse(raw) : null;
  },

  // ── String SET/GET (raw) ──
  set: async (key, val, ttlSeconds) => {
    if (redisClient && _isAvailable) {
      if (ttlSeconds) await redisClient.setex(key, ttlSeconds, String(val));
      else await redisClient.set(key, String(val));
    } else {
      _mockCache.set(key, { val: String(val), exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    }
  },

  get: async (key) => {
    if (redisClient && _isAvailable) return await redisClient.get(key);
    return _mockGet(key);
  },

  del: async (key) => {
    if (redisClient && _isAvailable) return await redisClient.del(key);
    _mockCache.delete(key);
  },

  expire: async (key, seconds) => {
    if (redisClient && _isAvailable) return await redisClient.expire(key, seconds);
  },

  incr: async (key) => {
    if (redisClient && _isAvailable) return await redisClient.incr(key);
    const raw = _mockGet(key);
    const newVal = (parseInt(raw || '0', 10) || 0) + 1;
    _mockCache.set(key, { val: String(newVal), exp: null });
    return newVal;
  },

  // ── Redis List Operations (used by strokeBuffer) ──
  rpush: async (key, ...values) => {
    if (redisClient && _isAvailable) {
      return await redisClient.rpush(key, ...values.map((v) => JSON.stringify(v)));
    }
    return 0; // Fallback handled inside strokeBuffer directly
  },

  lrange: async (key, start, stop) => {
    if (redisClient && _isAvailable) {
      const items = await redisClient.lrange(key, start, stop);
      return items.map((i) => JSON.parse(i));
    }
    return [];
  },

  ltrim: async (key, start, stop) => {
    if (redisClient && _isAvailable) return await redisClient.ltrim(key, start, stop);
  },

  llen: async (key) => {
    if (redisClient && _isAvailable) return await redisClient.llen(key);
    return 0;
  },

  // ── Pattern-based key search ──
  keys: async (pattern) => {
    if (redisClient && _isAvailable) return await redisClient.keys(pattern);
    // Mock: match from in-memory map
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return [..._mockCache.keys()].filter((k) => regex.test(k));
  },

  // ── Pipelining (for bulk operations) ──
  pipeline: () => {
    if (redisClient && _isAvailable) return redisClient.pipeline();
    return null;
  },
};

// ─── Factory for creating new independent Redis clients ───────────────────────
// Used by Socket.io Redis adapter (needs separate pub/sub clients)
const createRedisClient = () => {
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) return null;
  return new Redis(
    process.env.REDIS_URL || {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: null, // Required for BullMQ compatibility
    }
  );
};

const getRedisClient = () => redisClient;

module.exports = { connectRedis, getRedisClient, createRedisClient, cache };
