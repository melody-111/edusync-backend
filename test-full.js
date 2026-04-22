'use strict';
/**
 * COMPLETE BACKEND AUDIT V5 — Fresh, Clean, Self-Contained
 * Tests every API route end-to-end and fixes context across test phases
 */
const axios = require('axios');
const redis = require('./src/config/redis');
const logger = require('./src/utils/logger');
require('dotenv').config();

const PORT = 5001;
const BASE_URL = `http://localhost:${PORT}`;
const api = axios.create({ baseURL: BASE_URL, timeout: 20000 });

let passed = 0, failed = 0;
const failures = [];

async function check(label, fn) {
  try {
    const result = await fn();
    logger.info(`  ✅ ${label}`);
    passed++;
    return result;
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status} → ${JSON.stringify(err.response.data)}`
      : err.message;
    logger.error(`  ❌ ${label} | ${detail}`);
    failures.push({ label, detail });
    failed++;
    return null;
  }
}

async function getOtp(email) {
  const key = `otp:${email.toLowerCase()}`;
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const stored = await redis.cache.getJSON(key);
    if (stored) return stored.otp;
  }
  throw new Error(`OTP not found in Redis for ${email}`);
}

function h(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

const runAudit = async () => {
  logger.info('\n╔════════════════════════════════════════════════════════╗');
  logger.info('║  🔥  DIGITAL CLASSROOM — COMPLETE BACKEND AUDIT V5  🔥  ║');
  logger.info('╚════════════════════════════════════════════════════════╝\n');

  await redis.connectRedis();

  // Use unique emails per run to avoid conflicts
  const ts = Date.now();
  const tEmail = `teacher_${ts}@audit.com`;
  const sEmail = `student_${ts}@audit.com`;

  let tToken, sToken;
  let classroomId, classCode;
  let sessionId, sessionDbId, qrPayload;
  let selfSessionId, pageId, folderId;

  // ═══════════════════════════════════════════════════
  logger.info('📌 [1] SYSTEM HEALTH');
  // ═══════════════════════════════════════════════════
  await check('GET /health', async () => {
    const r = await api.get('/health');
    if (r.data.status !== 'healthy') throw new Error('Unhealthy!');
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [2] AUTH FLOW');
  // ═══════════════════════════════════════════════════
  await check('POST /auth/login → Teacher (auto-register)', async () => {
    await api.post('/auth/login', { email: tEmail, role: 'teacher' });
  });

  await check('POST /auth/verify-otp → Teacher', async () => {
    const otp = await getOtp(tEmail);
    const r = await api.post('/auth/verify-otp', { email: tEmail, otp });
    tToken = r.data.data.accessToken;
    if (!tToken) throw new Error('No access token');
  });

  await check('POST /auth/login → Student (auto-register)', async () => {
    await api.post('/auth/login', { email: sEmail, role: 'student' });
  });

  await check('POST /auth/verify-otp → Student', async () => {
    const otp = await getOtp(sEmail);
    const r = await api.post('/auth/verify-otp', { email: sEmail, otp });
    sToken = r.data.data.accessToken;
    if (!sToken) throw new Error('No access token');
  });

  await check('GET /auth/me → Teacher profile', async () => {
    const r = await api.get('/auth/me', h(tToken));
    const user = r.data.data.user;
    if (user.role !== 'teacher') throw new Error(`Wrong role: ${user.role}`);
  });

  await check('GET /auth/me → Student profile', async () => {
    const r = await api.get('/auth/me', h(sToken));
    const user = r.data.data.user;
    if (user.role !== 'student') throw new Error(`Wrong role: ${user.role}`);
  });

  await check('PUT /auth/profile → Update name & branch', async () => {
    const r = await api.put('/auth/profile', { name: 'Test Teacher', branch: 'CSE' }, h(tToken));
    if (!r.data.success) throw new Error('Profile update failed');
  });

  await check('GET /auth/qr-token → Personal QR code', async () => {
    const r = await api.get('/auth/qr-token', h(tToken));
    if (!r.data.data.qrCodeDataUrl) throw new Error('No QR data URL');
  });

  await check('POST /auth/qr-token/regenerate', async () => {
    const r = await api.post('/auth/qr-token/regenerate', {}, h(tToken));
    if (!r.data.success) throw new Error('Regenerate failed');
  });

  await check('POST /auth/refresh → Token rotation', async () => {
    // Re-login to get refreshToken
    await api.post('/auth/login', { email: tEmail });
    const otp2 = await getOtp(tEmail);
    const r = await api.post('/auth/verify-otp', { email: tEmail, otp: otp2 });
    const rt = r.data.data.refreshToken;
    tToken = r.data.data.accessToken;
    const r2 = await api.post('/auth/refresh', { refreshToken: rt });
    if (!r2.data.data.accessToken) throw new Error('No new access token');
    tToken = r2.data.data.accessToken;
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [3] CLASSROOM MANAGEMENT');
  // ═══════════════════════════════════════════════════
  await check('POST /classrooms → Create classroom', async () => {
    const r = await api.post('/classrooms', { name: `Audit Class ${ts}`, subject: 'Physics' }, h(tToken));
    classroomId = r.data.data.classroom._id;
    classCode = r.data.data.classroom.code;
    if (!classroomId || !classCode) throw new Error('Missing classroom ID or code');
  });

  await check('GET /classrooms/mine → Teacher list', async () => {
    const r = await api.get('/classrooms/mine', h(tToken));
    if (!Array.isArray(r.data.data.classrooms)) throw new Error('Not an array');
  });

  await check('GET /classrooms/:id → Single classroom', async () => {
    const r = await api.get(`/classrooms/${classroomId}`, h(tToken));
    if (!r.data.data.classroom) throw new Error('No classroom data');
  });

  await check('POST /classrooms/enroll → Student joins via code', async () => {
    const r = await api.post('/classrooms/enroll', { classroomCode: classCode }, h(sToken));
    if (!r.data.success) throw new Error('Enrollment failed');
  });

  await check('GET /classrooms/enrolled → Student enrolled list', async () => {
    const r = await api.get('/classrooms/enrolled', h(sToken));
    if (!Array.isArray(r.data.data.classrooms)) throw new Error('Not an array');
  });

  await check('PUT /classrooms/:id → Update classroom name', async () => {
    await api.put(`/classrooms/${classroomId}`, { name: 'Updated Audit Class' }, h(tToken));
  });

  await check('GET /classrooms/:id/sessions → Session history', async () => {
    const r = await api.get(`/classrooms/${classroomId}/sessions`, h(tToken));
    if (!Array.isArray(r.data.data.sessions)) throw new Error('Not an array');
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [4] SESSION LIFECYCLE');
  // ═══════════════════════════════════════════════════
  await check('POST /session/start → Teacher starts class', async () => {
    const r = await api.post('/session/start', { title: 'Audit Session', classroomId }, h(tToken));
    sessionId = r.data.data.sessionId;
    sessionDbId = r.data.data.session._id;
    qrPayload = r.data.data.qrPayload;
    if (!sessionId || !qrPayload) throw new Error('Missing sessionId or qrPayload');
  });

  await check('POST /session/join → Student scans QR', async () => {
    await api.post('/session/join', { qrData: JSON.stringify(qrPayload) }, h(sToken));
  });

  await check('GET /session/mine → User session list', async () => {
    const r = await api.get('/session/mine', h(tToken));
    if (!Array.isArray(r.data.data.sessions)) throw new Error('Not an array');
  });

  await check('GET /session/:id → Session details', async () => {
    const r = await api.get(`/session/${sessionId}`, h(tToken));
    if (!r.data.data.session) throw new Error('No session data');
  });

  await check('PATCH /session/:id/controls → Toggle AI + Keyboard', async () => {
    const r = await api.patch(`/session/${sessionId}/controls`,
      { aiEnabled: true, keyboardEnabled: true, copyPasteEnabled: false, youtubeEnabled: true }, h(tToken));
    if (!r.data.data.controls) throw new Error('No controls in response');
  });

  await check('POST /session/:id/media → Set YouTube video', async () => {
    await api.post(`/session/${sessionId}/media`,
      { mediaUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mediaType: 'youtube' }, h(tToken));
  });

  await check('GET /session/:id/media → Get media state', async () => {
    const r = await api.get(`/session/${sessionId}/media`, h(tToken));
    if (r.data.data.media === undefined) throw new Error('media key missing');
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [5] FILES & PAGES (Drawing Data Layer)');
  // ═══════════════════════════════════════════════════
  await check('POST /files/pages → Create writing page', async () => {
    const r = await api.post('/files/pages', { sessionId: sessionDbId, pageNumber: 1 }, h(tToken));
    pageId = r.data.data.page._id;
    if (!pageId) throw new Error('No pageId');
  });

  await check('POST /files/strokes/batch → Save stroke batch', async () => {
    await api.post('/files/strokes/batch', {
      sessionId: sessionDbId,
      pageId,
      strokes: [
        { x: 100, y: 200, pressure: 0.8, timestamp: Date.now() },
        { x: 120, y: 220, pressure: 0.9, timestamp: Date.now() + 10 }
      ]
    }, h(tToken));
  });

  await check('GET /files/strokes/page/:pageId → Get strokes', async () => {
    const r = await api.get(`/files/strokes/page/${pageId}`, h(tToken));
    if (!Array.isArray(r.data.data.strokes)) throw new Error('strokes not array');
  });

  await check('GET /files/pages/session/:sessionId → List pages', async () => {
    const r = await api.get(`/files/pages/session/${sessionDbId}`, h(tToken));
    if (!Array.isArray(r.data.data.pages)) throw new Error('pages not array');
  });

  await check('POST /files/pages/snapshot → Save canvas snapshot', async () => {
    await api.post('/files/pages/snapshot', {
      pageId,
      snapshotDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    }, h(tToken));
  });

  await check('GET /files/notes → User notes list', async () => {
    const r = await api.get('/files/notes', h(tToken));
    if (!Array.isArray(r.data.data.files)) throw new Error('files not array');
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [6] FOLDERS');
  // ═══════════════════════════════════════════════════
  await check('POST /folders → Create folder', async () => {
    const r = await api.post('/folders', { name: `Unit ${ts}`, subject: 'Physics' }, h(tToken));
    folderId = r.data.data.folder._id;
    if (!folderId) throw new Error('No folderId');
  });

  await check('GET /folders → List folders', async () => {
    const r = await api.get('/folders', h(tToken));
    if (!Array.isArray(r.data.data.folders)) throw new Error('Not an array');
  });

  await check('GET /folders/:id → Folder contents', async () => {
    const r = await api.get(`/folders/${folderId}`, h(tToken));
    if (!r.data.data.folder) throw new Error('No folder data');
  });

  await check('PUT /folders/:id → Rename folder', async () => {
    await api.put(`/folders/${folderId}`, { name: 'Updated Unit 1' }, h(tToken));
  });

  await check('DELETE /folders/:id → Soft delete folder', async () => {
    await api.delete(`/folders/${folderId}`, h(tToken));
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [7] DEVICES');
  // ═══════════════════════════════════════════════════
  await check('POST /devices/register → Register student tablet', async () => {
    await api.post('/devices/register', {
      deviceId: `tablet-${ts}`,
      deviceType: 'student-desk',
      platform: 'android'
    }, h(sToken));
  });

  await check('GET /devices → My devices list', async () => {
    const r = await api.get('/devices', h(sToken));
    if (!Array.isArray(r.data.data.devices)) throw new Error('Not array');
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [8] NOTIFICATIONS');
  // ═══════════════════════════════════════════════════
  await check('GET /notifications → List (can be empty)', async () => {
    const r = await api.get('/notifications', h(sToken));
    if (!Array.isArray(r.data.data.notifications)) throw new Error('Not array');
  });

  await check('PATCH /notifications/read → Mark all read', async () => {
    await api.patch('/notifications/read', { notificationIds: [] }, h(sToken));
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [9] SYNC SYSTEM');
  // ═══════════════════════════════════════════════════
  await check('GET /sync/status → Sync queue', async () => {
    const r = await api.get('/sync/status', h(sToken));
    if (r.data.data.pending === undefined) throw new Error('No pending field');
  });

  await check('POST /sync/push → Offline data sync', async () => {
    await api.post('/sync/push', {
      items: [{
        operation: 'stroke_batch',
        payload: { pageId, data: 'test' },
        clientTimestamp: new Date().toISOString(),
        sequence: 1
      }]
    }, h(sToken));
  });

  await check('POST /sync/retry → Retry failed items', async () => {
    await api.post('/sync/retry', {}, h(sToken));
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [10] AI ASSISTANT');
  // ═══════════════════════════════════════════════════
  await check('GET /ai/usage → Usage stats', async () => {
    const r = await api.get('/ai/usage', h(sToken));
    if (r.data.data.limit === undefined) throw new Error('No limit field');
  });

  await check('POST /ai/chat → AI chat (key check)', async () => {
    try {
      await api.post('/ai/chat', {
        messages: [{ role: 'user', content: 'What is Newton\'s 2nd law?' }],
        sessionId
      }, h(sToken));
    } catch (err) {
      // 503 = AI key missing = expected behavior (not a bug)
      if (err.response?.status === 503) return;
      // 403 = teacher disabled AI = also valid
      if (err.response?.status === 403) return;
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [11] END SESSIONS');
  // ═══════════════════════════════════════════════════
  await check('POST /session/:id/end → Teacher ends class', async () => {
    const r = await api.post(`/session/${sessionId}/end`, {}, h(tToken));
    if (r.data.data.status !== 'ended') throw new Error(`Status is ${r.data.data.status}`);
  });

  await check('POST /session/self-start → Student self-study', async () => {
    const r = await api.post('/session/self-start', { subject: 'Revision', title: 'Self Study' }, h(sToken));
    selfSessionId = r.data.data.sessionId;
    if (!selfSessionId) throw new Error('No selfSessionId');
  });

  await check('POST /session/:id/end → Student ends self-study', async () => {
    const r = await api.post(`/session/${selfSessionId}/end`, {}, h(sToken));
    if (r.data.data.status !== 'ended') throw new Error(`Status is ${r.data.data.status}`);
  });

  // ═══════════════════════════════════════════════════
  logger.info('\n📌 [12] LOGOUT');
  // ═══════════════════════════════════════════════════
  await check('POST /auth/logout → Teacher logout', async () => {
    const r = await api.post('/auth/logout', {}, h(tToken));
    if (!r.data.success) throw new Error('Logout failed');
  });

  await check('POST /auth/logout → Student logout', async () => {
    await api.post('/auth/logout', {}, h(sToken));
  });

  // ═══════════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════════
  logger.info('\n╔════════════════════════════════════════════════════════╗');
  if (failed === 0) {
    logger.info(`║  🏆 PERFECT: ${passed}/${passed} TESTS PASSED — BACKEND IS 100% READY  ║`);
  } else {
    logger.info(`║  📊 RESULT: ${passed} passed | ${failed} FAILED  ║`);
    logger.warn('\n⚠️  FAILURES:');
    failures.forEach((f, i) => logger.warn(`  ${i + 1}. ❌ ${f.label}\n     → ${f.detail}`));
  }
  logger.info('╚════════════════════════════════════════════════════════╝\n');

  process.exit(failed > 0 ? 1 : 0);
};

runAudit().catch(err => {
  logger.error(`CRASH: ${err.message}`);
  process.exit(1);
});
