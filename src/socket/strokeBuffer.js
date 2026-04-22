'use strict';

const StrokeBatch = require('../models/StrokeBatch');
const Page = require('../models/Page');
const { compressStrokes } = require('../utils/compression');
const { cache, getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

const FLUSH_INTERVAL_MS = 4000; // Flush every 4 seconds
const MAX_BUFFER_SIZE = 500;    // Force-flush at 500 strokes
const SCAN_COUNT = 100;         // Keys per SCAN batch — non-blocking

const KEY_PREFIX = 'strokebuf:';   // Redis list key prefix for stroke data
const META_PREFIX = 'strokemeta:'; // Redis key prefix for session/page metadata

/**
 * Redis-backed Stroke Buffer
 *
 * Strategy:
 * - If Redis is AVAILABLE: strokes stored in Redis Lists → survive server restarts,
 *   work across multiple server instances (horizontal scaling).
 * - If Redis is UNAVAILABLE (fallback): stored in-memory Map → single-server only,
 *   data will be lost on crash (acceptable for dev/solo mode).
 */
class StrokeBatchBuffer {
  constructor() {
    this._fallback = new Map(); // in-memory fallback map
    this._batchCounters = new Map();
    this._startGlobalFlush();
  }

  // ─── Key helpers ──────────────────────────────────────────────────
  _redisKey(sessionId, userId) {
    return `${KEY_PREFIX}${sessionId}:${userId}`;
  }

  _metaKey(sessionId, userId) {
    return `${META_PREFIX}${sessionId}:${userId}`;
  }

  _fallbackKey(sessionId, userId) {
    return `${sessionId}:${userId}`;
  }

  // ─── Non-blocking SCAN helper (replaces KEYS * which blocks Redis) ──
  // KEYS * is O(N) blocking — with 1M+ keys it freezes Redis for seconds.
  // SCAN uses cursor-based iteration, returns in small batches, non-blocking.
  async _scanRedisKeys(pattern) {
    const client = getRedisClient();
    if (!client) return [];
    const results = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH', pattern,
        'COUNT', SCAN_COUNT
      );
      cursor = nextCursor;
      results.push(...keys);
    } while (cursor !== '0');
    return results;
  }

  // ─── Global timer — ONE interval for the whole server ────────────
  _startGlobalFlush() {
    if (this._globalTimer) return;

    this._globalTimer = setInterval(async () => {
      // 1. Flush Redis-backed buffers using non-blocking SCAN (NOT KEYS *)
      if (cache.isAvailable()) {
        const redisKeys = await this._scanRedisKeys(`${KEY_PREFIX}*`).catch(() => []);
        for (const key of redisKeys) {
          // Parse sessionId and userId from key: "strokebuf:SESSION:USER"
          const suffix = key.slice(KEY_PREFIX.length);
          const colonIdx = suffix.indexOf(':');
          if (colonIdx === -1) continue;
          const sessionId = suffix.substring(0, colonIdx);
          const userId = suffix.substring(colonIdx + 1);
          this.flush(sessionId, userId).catch(() => {});
        }
      }

      // 2. Flush in-memory fallback buffers (when Redis is not available)
      for (const [, buf] of this._fallback.entries()) {
        if (buf.strokes.length > 0) {
          this.flush(buf.sessionId, buf.userId).catch(() => {});
        }
      }
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Add a stroke to the buffer for a session/user
   * @param {string} sessionId
   * @param {string} userId
   * @param {'teacher'|'student'} role
   * @param {object} strokeData
   */
  async add(sessionId, userId, role, strokeData) {
    const stroke = {
      x: strokeData.x,
      y: strokeData.y,
      pressure: strokeData.pressure ?? 0.5,
      tiltX: strokeData.tiltX || 0,
      tiltY: strokeData.tiltY || 0,
      pointerType: strokeData.pointerType || 'pen',
      color: strokeData.color || '#000000',
      width: strokeData.width || 2,
      tool: strokeData.tool || 'pen',
      ts: strokeData.ts || Date.now(),
    };

    if (cache.isAvailable()) {
      // ── Redis path ───────────────────────────────────────────────
      const key = this._redisKey(sessionId, userId);
      const metaKey = this._metaKey(sessionId, userId);

      // RPUSH stroke to Redis list
      const listLen = await cache.rpush(key, stroke);

      // Store metadata (sessionId, userId, role, pageId) separately if not already set
      const existingMeta = await cache.getJSON(metaKey);
      if (!existingMeta) {
        await cache.setJSON(metaKey, { sessionId, userId, role, pageId: strokeData.pageId });
      }

      // Safety expiry: auto-cleanup after 2 hours if flush never happens
      await cache.expire(key, 7200);
      await cache.expire(metaKey, 7200);

      // Force flush if buffer is full
      if (listLen >= MAX_BUFFER_SIZE) {
        this.flush(sessionId, userId).catch((err) =>
          logger.error(`[StrokeBuffer] Force flush error: ${err.message}`)
        );
      }
    } else {
      // ── In-memory fallback path ──────────────────────────────────
      const fbKey = this._fallbackKey(sessionId, userId);
      if (!this._fallback.has(fbKey)) {
        this._fallback.set(fbKey, {
          strokes: [],
          sessionId,
          userId,
          role,
          pageId: strokeData.pageId,
        });
      }
      const buf = this._fallback.get(fbKey);
      buf.strokes.push(stroke);

      if (buf.strokes.length >= MAX_BUFFER_SIZE) {
        this.flush(sessionId, userId).catch((err) =>
          logger.error(`[StrokeBuffer] Force flush error (fallback): ${err.message}`)
        );
      }
    }
  }

  /**
   * Flush buffered strokes to DB as a single compressed batch
   * @param {string} sessionId
   * @param {string} userId
   */
  async flush(sessionId, userId) {
    let strokes = [];
    let meta = null;

    if (cache.isAvailable()) {
      // ── Redis flush ──────────────────────────────────────────────
      const key = this._redisKey(sessionId, userId);
      const metaKey = this._metaKey(sessionId, userId);

      const len = await cache.llen(key);
      if (!len || len === 0) return;

      // Atomically read and drain the list
      strokes = await cache.lrange(key, 0, len - 1);
      await cache.ltrim(key, len, -1); // Remove the items we just read

      meta = await cache.getJSON(metaKey);
    } else {
      // ── Fallback flush ───────────────────────────────────────────
      const fbKey = this._fallbackKey(sessionId, userId);
      const buf = this._fallback.get(fbKey);
      if (!buf || buf.strokes.length === 0) return;

      strokes = buf.strokes.splice(0); // Drain array
      meta = { sessionId, userId, role: buf.role, pageId: buf.pageId };
    }

    if (!strokes.length) return;

    const counterKey = `${sessionId}:${meta?.pageId}`;
    const batchIndex = (this._batchCounters.get(counterKey) || 0) + 1;
    this._batchCounters.set(counterKey, batchIndex);

    try {
      // Ensure page record exists
      let page = await Page.findById(meta?.pageId).lean();
      if (!page) {
        page = await Page.create({
          sessionId,
          ownerId: userId,
          ownerRole: meta?.role || 'teacher',
          pageNumber: 1,
        });
      }

      const compressed = await compressStrokes(strokes);

      await StrokeBatch.create({
        sessionId,
        pageId: page._id,
        ownerId: userId,
        ownerRole: meta?.role || 'student',
        strokesData: compressed,
        strokeCount: strokes.length,
        batchIndex,
        compressed: true,
      });

      logger.debug(`[StrokeBuffer] Flushed ${strokes.length} strokes for session ${sessionId}, user ${userId}`);
    } catch (err) {
      logger.error(`[StrokeBuffer] DB write failed: ${err.message}`);

      // ── Retry: put strokes back into buffer ──
      if (cache.isAvailable()) {
        const key = this._redisKey(sessionId, userId);
        // Use a pipeline to re-insert at front (LPUSH, reversed)
        const pipe = cache.pipeline();
        if (pipe) {
          for (const s of [...strokes].reverse()) {
            pipe.lpush(key, JSON.stringify(s));
          }
          await pipe.exec().catch(() => {});
          logger.warn(`[StrokeBuffer] ${strokes.length} strokes re-queued in Redis for retry.`);
        }
      } else {
        const fbKey = this._fallbackKey(sessionId, userId);
        if (this._fallback.has(fbKey)) {
          this._fallback.get(fbKey).strokes.unshift(...strokes);
        }
      }
    }
  }

  /**
   * Flush ALL buffers for a session (called on session end)
   * @param {string} sessionId
   */
  async flushAll(sessionId) {
    const promises = [];

    // Flush Redis-backed buffers for this session — use SCAN (not KEYS *)
    if (cache.isAvailable()) {
      const redisKeys = await this._scanRedisKeys(`${KEY_PREFIX}${sessionId}:*`).catch(() => []);
      for (const key of redisKeys) {
        const userId = key.slice(`${KEY_PREFIX}${sessionId}:`.length);
        if (userId) promises.push(this.flush(sessionId, userId));
      }
    }

    // Flush in-memory fallback buffers for this session
    for (const [fbKey, buf] of this._fallback.entries()) {
      if (buf.sessionId === sessionId) {
        promises.push(this.flush(buf.sessionId, buf.userId));
        this._fallback.delete(fbKey);
      }
    }

    await Promise.allSettled(promises);
    logger.info(`[StrokeBuffer] All buffers flushed for session ${sessionId}`);
  }

  /**
   * Flush and clean up for a single user (on disconnect)
   * @param {string} sessionId
   * @param {string} userId
   */
  async stopAndFlush(sessionId, userId) {
    await this.flush(sessionId, userId);
    this._fallback.delete(this._fallbackKey(sessionId, userId));
  }
}

// Singleton — shared across the whole server process
const strokeBatchBuffer = new StrokeBatchBuffer();

module.exports = { strokeBatchBuffer };
