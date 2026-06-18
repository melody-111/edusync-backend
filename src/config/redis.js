'use strict';

const Redis = require('ioredis');
const logger = require('../utils/logger');

let redisClient = null;
let _isAvailable = false;

// ─── Why Redis Disconnects on RedisLabs Cloud ──────────────────────────────────
// RedisLabs (Redis Cloud) free tier REQUIRES TLS (port 10774 + TLS).
// Without `tls: { rejectUnauthorized: false }`, ioredis connects on plain TCP
// and the handshake fails silently → Redis shows as "disconnected" in /health.
// Fix: always enable TLS when REDIS_TLS=true AND set rejectUnauthorized:false
// because RedisLabs uses a self-signed cert on free tier.
// ─────────────────────────────────────────────────────────────────────────────

const connectRedis = async () => {
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
    logger.warn('[Redis] No REDIS_URL or REDIS_HOST configured — using in-memory fallback.');
    return;
  }

  try {
    let config;

    if (process.env.REDIS_URL) {
      // URL-based config (e.g. rediss://...)
      config = {
        ...(process.env.REDIS_URL.startsWith('rediss://') || process.env.REDIS_TLS === 'true'
          ? { tls: { rejectUnauthorized: false } }
          : {}),
      };
      // ioredis accepts URL as first arg when using the constructor with object
      redisClient = new Redis(process.env.REDIS_URL, {
        ...config,
        maxRetriesPerRequest: null,     // allow unlimited retries per request
        connectTimeout: 15000,
        commandTimeout: 8000,
        lazyConnect: false,
        retryStrategy(times) {
          // Keep retrying every 5s indefinitely — never give up
          const delay = Math.min(times * 500, 5000);
          logger.warn(`[Redis] Reconnect attempt #${times}, next try in ${delay}ms`);
          return delay;
        },
        reconnectOnError(err) {
          // Reconnect on READONLY or connection errors
          return err.message.includes('READONLY') || err.message.includes('ECONNRESET');
        },
      });
    } else {
      // Host/port based config (used when REDIS_HOST is set — RedisLabs free tier)
      const host = process.env.REDIS_HOST;
      const port = parseInt(process.env.REDIS_PORT, 10) || 6379;
      const password = process.env.REDIS_PASSWORD;
      const useTLS = process.env.REDIS_TLS === 'true';

      config = {
        host,
        port,
        ...(password ? { password } : {}),
        // ⚠️  CRITICAL: RedisLabs free tier uses TLS with self-signed cert.
        // rejectUnauthorized:false is required or the TLS handshake will fail.
        ...(useTLS ? { tls: { rejectUnauthorized: false, servername: host } } : {}),
        maxRetriesPerRequest: null,
        connectTimeout: 15000,
        commandTimeout: 8000,
        lazyConnect: false,
        retryStrategy(times) {
          const delay = Math.min(times * 500, 5000);
          if (times <= 3) logger.warn(`[Redis] Reconnect attempt #${times}, next in ${delay}ms`);
          return delay; // never return null — always keep retrying
        },
        reconnectOnError(err) {
          return err.message.includes('READONLY') || err.message.includes('ECONNRESET');
        },
      };

      redisClient = new Redis(config);
    }

    // ── Event Handlers ────────────────────────────────────────────────────────
    redisClient.on('connect', () => {
      logger.info('[Redis] TCP connected, awaiting AUTH...');
    });

    redisClient.on('ready', () => {
      _isAvailable = true;
      logger.info('[Redis] ✅ Connected and ready.');
    });

    redisClient.on('error', (err) => {
      // Don't spam logs — only flag as unavailable
      _isAvailable = false;
      // Log TLS errors clearly since they're the most common misconfiguration
      if (err.code === 'SELF_SIGNED_CERT_IN_CHAIN' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        logger.error('[Redis] TLS cert error — set REDIS_TLS=true and ensure rejectUnauthorized:false');
      } else if (err.code === 'ECONNREFUSED') {
        logger.warn('[Redis] Connection refused — check REDIS_HOST/PORT');
      } else if (err.message?.includes('WRONGPASS') || err.message?.includes('NOAUTH')) {
        logger.error('[Redis] Auth failed — check REDIS_PASSWORD in .env');
      }
      // else silent fallback to in-memory
    });

    redisClient.on('reconnecting', (delay) => {
      logger.warn(`[Redis] Reconnecting in ${delay}ms...`);
    });

    redisClient.on('close', () => {
      _isAvailable = false;
      logger.warn('[Redis] Connection closed — using in-memory fallback.');
    });

    // ── Initial Ping to Verify ────────────────────────────────────────────────
    try {
      const pong = await redisClient.ping();
      if (pong === 'PONG') {
        _isAvailable = true;
        logger.info('[Redis] ✅ Ping successful — Redis is live.');
      } else {
        logger.warn('[Redis] Unexpected ping response:', pong);
        _isAvailable = false;
      }
    } catch (pingErr) {
      logger.warn(`[Redis] Ping failed: ${pingErr.message} — using in-memory fallback.`);
      _isAvailable = false;
    }

  } catch (err) {
    logger.warn(`[Redis] Startup failed: ${err.message} — falling back to in-memory cache.`);
    redisClient = null;
    _isAvailable = false;
  }
};

// ─── In-Memory Fallback Cache ─────────────────────────────────────────────────
// Activated automatically when Redis is unavailable.
// Works across all auth flows: OTP, rate limiting, token blacklisting.
// NOTE: This is per-process. On multi-instance deployments, use Redis.
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
// All methods transparently use Redis (if up) or in-memory (if Redis is down).
const cache = {
  isAvailable: () => _isAvailable,

  exists: async (key) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.exists(key); } catch { /* fallthrough */ }
    }
    return _mockGet(key) !== null ? 1 : 0;
  },

  setJSON: async (key, val, ttlSeconds) => {
    const str = JSON.stringify(val);
    if (redisClient && _isAvailable) {
      try {
        if (ttlSeconds) await redisClient.setex(key, ttlSeconds, str);
        else await redisClient.set(key, str);
        return;
      } catch { /* fallthrough to memory */ }
    }
    _mockCache.set(key, {
      val: str,
      exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  },

  getJSON: async (key) => {
    if (redisClient && _isAvailable) {
      try {
        const val = await redisClient.get(key);
        return val ? JSON.parse(val) : null;
      } catch { /* fallthrough */ }
    }
    const raw = _mockGet(key);
    return raw ? JSON.parse(raw) : null;
  },

  set: async (key, val, ttlSeconds) => {
    if (redisClient && _isAvailable) {
      try {
        if (ttlSeconds) await redisClient.setex(key, ttlSeconds, String(val));
        else await redisClient.set(key, String(val));
        return;
      } catch { /* fallthrough */ }
    }
    _mockCache.set(key, {
      val: String(val),
      exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  },

  get: async (key) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.get(key); } catch { /* fallthrough */ }
    }
    return _mockGet(key);
  },

  del: async (key) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.del(key); } catch { /* fallthrough */ }
    }
    _mockCache.delete(key);
  },

  expire: async (key, seconds) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.expire(key, seconds); } catch { /* fallthrough */ }
    }
    // For in-memory, update expiry of existing entry
    const data = _mockCache.get(key);
    if (data) {
      _mockCache.set(key, { ...data, exp: Date.now() + seconds * 1000 });
    }
  },

  incr: async (key) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.incr(key); } catch { /* fallthrough */ }
    }
    const raw = _mockGet(key);
    const newVal = (parseInt(raw || '0', 10) || 0) + 1;
    const existing = _mockCache.get(key);
    _mockCache.set(key, { val: String(newVal), exp: existing?.exp ?? null });
    return newVal;
  },

  rpush: async (key, ...values) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.rpush(key, ...values.map((v) => JSON.stringify(v))); }
      catch { /* fallthrough */ }
    }
    return 0;
  },

  lrange: async (key, start, stop) => {
    if (redisClient && _isAvailable) {
      try {
        const items = await redisClient.lrange(key, start, stop);
        return items.map((i) => JSON.parse(i));
      } catch { /* fallthrough */ }
    }
    return [];
  },

  ltrim: async (key, start, stop) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.ltrim(key, start, stop); } catch { /* fallthrough */ }
    }
  },

  llen: async (key) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.llen(key); } catch { /* fallthrough */ }
    }
    return 0;
  },

  keys: async (pattern) => {
    if (redisClient && _isAvailable) {
      try { return await redisClient.keys(pattern); } catch { /* fallthrough */ }
    }
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return [..._mockCache.keys()].filter((k) => regex.test(k));
  },

  pipeline: () => {
    if (redisClient && _isAvailable) return redisClient.pipeline();
    return null;
  },
};

// ─── Factory: Independent Redis Clients ──────────────────────────────────────
// Used by Socket.io Redis adapter (requires separate pub/sub clients)
const createRedisClient = () => {
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) return null;

  const useTLS = process.env.REDIS_TLS === 'true';
  const tlsConfig = useTLS ? { tls: { rejectUnauthorized: false } } : {};

  let client;
  if (process.env.REDIS_URL) {
    client = new Redis(process.env.REDIS_URL, {
      ...tlsConfig,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      connectTimeout: 15000,
    });
  } else {
    client = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      ...tlsConfig,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      connectTimeout: 15000,
    });
  }
  
  // Attach empty error handler to prevent 'missing error handler' log spam
  client.on('error', () => {});
  
  return client;
};

const getRedisClient = () => redisClient;

module.exports = { connectRedis, getRedisClient, createRedisClient, cache };
