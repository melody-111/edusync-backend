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
    let config;
    if (process.env.REDIS_URL) {
      config = process.env.REDIS_URL;
      // If URL is provided but password is in a separate env var, ioredis might need it explicitly
      if (process.env.REDIS_PASSWORD && !config.includes(`:${process.env.REDIS_PASSWORD}@`)) {
        config = {
          url: process.env.REDIS_URL,
          password: process.env.REDIS_PASSWORD,
        };
      }
    } else {
      const host = process.env.REDIS_HOST || '127.0.0.1';
      const port = process.env.REDIS_PORT || 6379;
      const password = process.env.REDIS_PASSWORD;
      
      if (password) {
        // Use URL format for better compatibility with Cloud providers
        config = `redis://default:${encodeURIComponent(password)}@${host}:${port}`;
      } else {
        config = { host, port };
      }
      
      // Only use TLS if explicitly requested or if it's a secure redis port (usually 6380+)
      // Note: Redis Labs often uses non-TLS ports for some plans.
      if (process.env.REDIS_TLS === 'true') {
        const url = typeof config === 'string' ? config.replace('redis://', 'rediss://') : config;
        config = url;
      }
    }

    // Common options
    const redisOptions = {
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 300, 2000);
      },
    };

    if (typeof config === 'object') {
      Object.assign(config, redisOptions);
    }

    redisClient = new Redis(config);

    redisClient.on('error', (err) => {
      _isAvailable = false;
      // Only log unique errors to avoid spam
      if (err.message.includes('NOAUTH')) {
        // Fallback is already handled, no need to spam
      } else {
        logger.debug(`[Redis] Silent fallback active: ${err.message}`);
      }
    });

    try {
      await redisClient.ping(); // Verify connection
      _isAvailable = true;
      logger.info('[Redis] Connected successfully.');
    } catch (pingErr) {
      logger.error(`[Redis] Ping failed: ${pingErr.message}. Fallback to memory.`);
      _isAvailable = false;
    }

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

  let config;
  if (process.env.REDIS_URL) {
    config = process.env.REDIS_URL;
    if (process.env.REDIS_PASSWORD && !config.includes(`:${process.env.REDIS_PASSWORD}@`)) {
      config = {
        url: process.env.REDIS_URL,
        password: process.env.REDIS_PASSWORD,
      };
    }
  } else {
    config = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
    };
  }

  // Common adapter options
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: null, // Required for BullMQ/Adapters
    connectTimeout: 10000,
  };

  if (typeof config === 'object') {
    Object.assign(config, options);
  } else {
    // If config is string (URL), we can't easily merge options here without ioredis parsing it first
    // but ioredis constructor handles string + object options
    return new Redis(config, options);
  }

  return new Redis(config);
};

const getRedisClient = () => redisClient;

module.exports = { connectRedis, getRedisClient, createRedisClient, cache };
