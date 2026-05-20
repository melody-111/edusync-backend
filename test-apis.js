#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   EduSync — Full API Test Suite (Postman Style)      ║
 * ║   Real OTP Flow — No dev bypass                      ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * HOW TO RUN:
 *   node test-apis.js
 *
 *   It will trigger OTP to your Gmail, ask you to paste it,
 *   then test ALL APIs with the obtained JWT token.
 */

const https = require('https');
const readline = require('readline');

const BASE_HOST = 'edusync-backend-application.onrender.com';
const BASE = `https://${BASE_HOST}`;

const TEST_EMAIL = 'sudhanshusonkar210@gmail.com';
const TEST_ROLE  = 'teacher';

let TOKEN = '';
let REFRESH_TOKEN = '';
let SESSION_ID = '';
let TERMINAL_ID = '';
let RESULTS = [];
let testNum = 0;

// ─── Prompt Helper ────────────────────────────────────────────────
function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
  });
}

// ─── HTTP Helper ──────────────────────────────────────────────────
function httpReq(method, path, body, token, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: BASE_HOST,
      port: 443,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: timeoutMs,
    };

    const r = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ s: res.statusCode, b: JSON.parse(data) }); }
        catch { resolve({ s: res.statusCode, b: null, raw: data.slice(0, 400) }); }
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ s: 'TIMEOUT', b: null, raw: 'Render cold start timeout' }); });
    r.on('error', (e) => resolve({ s: 'NET_ERR', b: null, raw: e.message }));
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

// ─── Test Logger ──────────────────────────────────────────────────
function test(label, method, path, res, expectedCodes, note = '') {
  testNum++;
  const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  const codeOk = codes.includes(res.s);
  const isOk   = typeof res.s === 'number' && res.s >= 200 && res.s < 300;
  const icon   = res.s === 'TIMEOUT' ? '⏱ ' : codeOk ? (isOk ? '✅' : '⚠️ ') : '❌';
  const status = codeOk ? (isOk ? 'PASS' : 'WARN') : 'FAIL';
  RESULTS.push({ num: testNum, status, method, path: path.split('?')[0], code: res.s, label });

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`${icon} #${String(testNum).padStart(2,'0')} ${label}`);
  console.log(`   ${method} ${BASE}${path}`);
  console.log(`   Status : ${res.s} ${codeOk ? '✓ expected' : `✗ expected [${codes.join(',')}]`}`);
  if (note) console.log(`   Info   : ${note}`);

  const d = res.b;
  if (d) {
    if (d.message) console.log(`   Msg    : ${String(d.message).slice(0, 150)}`);
    if (d.data) {
      const data = d.data;
      ['name','email','role','_id','sessionId','terminalId','accessToken','refreshToken','reply','url'].forEach(k => {
        if (data[k] !== undefined) {
          const v = typeof data[k] === 'string' ? data[k].slice(0, 80) : JSON.stringify(data[k]).slice(0, 80);
          console.log(`   ${k.padEnd(14)}: ${v}${(data[k] || '').length > 80 ? '…' : ''}`);
        }
      });
      if (Array.isArray(data.items))   console.log(`   items         : ${data.items.length} results`);
      if (Array.isArray(data.files))   console.log(`   files         : ${data.files.length} files`);
      if (Array.isArray(data.folders)) console.log(`   folders       : ${data.folders.length} folders`);
      if (data.qrCodeDataUrl)          console.log(`   qrCodeDataUrl : [base64 image present ✓]`);
      if (data.services)               console.log(`   services      : ${JSON.stringify(data.services)}`);
    }
  } else if (res.raw) {
    console.log(`   Raw    : ${res.raw.slice(0, 200)}`);
  }
  return res;
}

// ─── MAIN ─────────────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         EduSync — Full API Test Suite (Postman Style)        ║
║  Target  : ${BASE}  ║
║  Time    : ${new Date().toISOString()}                ║
╚══════════════════════════════════════════════════════════════╝`);

  // ════════════ SECTION 1: HEALTH ═════════════
  console.log('\n━━━ SECTION 1: HEALTH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const r = await httpReq('GET', '/health');
    const note = r.b?.services ? `MongoDB:${r.b.services.mongodb}  Redis:${r.b.services.redis}` : '';
    test('Health Check', 'GET', '/health', r, [200, 503], note);
  }

  // ════════════ SECTION 2: AUTH — OTP FLOW ════
  console.log('\n━━━ SECTION 2: AUTH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n  📧 Triggering OTP login for: ${TEST_EMAIL}`);
  console.log(`     Check your Gmail inbox after this step.\n`);

  // 2a. Trigger OTP
  {
    const body = { email: TEST_EMAIL, role: TEST_ROLE };
    const r = await httpReq('POST', '/auth/login', body);
    test('OTP Login — Send OTP to Gmail', 'POST', '/auth/login', r, [200, 400]);
  }

  // 2b. Wait for user to enter OTP from Gmail
  console.log('\n  ┌────────────────────────────────────────┐');
  console.log(`  │  📬 Check Gmail: ${TEST_EMAIL}  │`);
  console.log('  │  You will receive an EduSync OTP email │');
  console.log('  └────────────────────────────────────────┘\n');

  const otp = await prompt('  Enter the 6-digit OTP from your Gmail: ');

  // 2c. Verify OTP → get token
  {
    const body = { email: TEST_EMAIL, otp };
    const r = await httpReq('POST', '/auth/verify-otp', body);
    test('Verify OTP → Get JWT Token', 'POST', '/auth/verify-otp', r, [200, 400]);
    if (r.b?.data?.accessToken) {
      TOKEN = r.b.data.accessToken;
      REFRESH_TOKEN = r.b.data.refreshToken || '';
      console.log(`\n  🔑 TOKEN: ${TOKEN.slice(0, 55)}…`);
    }
  }

  if (!TOKEN) {
    console.log('\n  ❌ Could not get token. OTP wrong or expired. Exiting auth tests.\n');
  }

  // 2d. GET /auth/me
  {
    const r = await httpReq('GET', '/auth/me', null, TOKEN);
    test('Get Current User (me)', 'GET', '/auth/me', r, [200, 401]);
  }

  // 2e. Dashboard stats
  {
    const r = await httpReq('GET', '/auth/dashboard-stats', null, TOKEN);
    test('Dashboard Stats', 'GET', '/auth/dashboard-stats', r, [200, 401]);
  }

  // 2f. Update profile
  {
    const body = { branch: 'Computer Science', semester: '5', year: '2024' };
    const r = await httpReq('PUT', '/auth/profile', body, TOKEN);
    test('Update User Profile', 'PUT', '/auth/profile', r, [200, 401]);
  }

  // 2g. Forgot password (send reset OTP to Gmail)
  {
    const body = { email: TEST_EMAIL };
    const r = await httpReq('POST', '/auth/forgot-password', body);
    test('Forgot Password (OTP to Gmail)', 'POST', '/auth/forgot-password', r, [200, 400]);
  }

  // 2h. Search teacher
  {
    const r = await httpReq('GET', '/auth/teacher/TCH-000001', null, TOKEN);
    test('Search Teacher by Desk ID', 'GET', '/auth/teacher/TCH-000001', r, [200, 401, 404]);
  }

  // 2i. Terminal QR Init (public)
  {
    const r = await httpReq('GET', '/auth/terminal/init', null, null);
    test('Terminal QR Init (public — no auth)', 'GET', '/auth/terminal/init', r, [200]);
    if (r.b?.data?.terminalId) {
      TERMINAL_ID = r.b.data.terminalId;
      console.log(`  📱 Terminal ID: ${TERMINAL_ID}`);
    }
  }

  // 2j. Terminal status
  if (TERMINAL_ID) {
    const r = await httpReq('GET', `/auth/terminal/status/${TERMINAL_ID}`, null, null);
    test('Terminal Status Check', 'GET', '/auth/terminal/status/:id', r, [200]);
  }

  // 2k. Personal QR Token
  {
    const r = await httpReq('GET', '/auth/qr-token', null, TOKEN);
    test('Get Personal QR Token', 'GET', '/auth/qr-token', r, [200, 401]);
  }

  // 2l. Refresh Token
  if (REFRESH_TOKEN) {
    const r = await httpReq('POST', '/auth/refresh', { refreshToken: REFRESH_TOKEN });
    test('Refresh Access Token', 'POST', '/auth/refresh', r, [200, 401]);
    if (r.b?.data?.accessToken) TOKEN = r.b.data.accessToken;
  }

  // ════════════ SECTION 3: SESSION ════════════
  console.log('\n━━━ SECTION 3: SESSION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const body = { subject: 'Math — API Test Class', classroomId: 'room_api_001' };
    const r = await httpReq('POST', '/session/start', body, TOKEN);
    test('Teacher Start Session', 'POST', '/session/start', r, [200, 201, 401, 403]);
    if (r.b?.data?._id) SESSION_ID = r.b.data._id;
    if (r.b?.data?.sessionId) SESSION_ID = r.b.data.sessionId;
  }

  {
    const body = { subject: 'Self Study — API Test' };
    const r = await httpReq('POST', '/session/self-start', body, TOKEN);
    test('Self-Start Session', 'POST', '/session/self-start', r, [200, 201, 401]);
    if (!SESSION_ID && r.b?.data?._id) SESSION_ID = r.b.data._id;
  }

  {
    const r = await httpReq('GET', '/session/mine', null, TOKEN);
    test('Get My Sessions', 'GET', '/session/mine', r, [200, 401],
      r.b?.data ? `${Array.isArray(r.b.data) ? r.b.data.length : 0} sessions` : '');
  }

  if (SESSION_ID) {
    const r = await httpReq('GET', `/session/${SESSION_ID}`, null, TOKEN);
    test('Get Session by ID', 'GET', '/session/:id', r, [200, 401, 404]);
  }

  {
    const body = { sessionId: SESSION_ID || 'test', canvasData: '{"objects":[]}', pageIndex: 0 };
    const r = await httpReq('POST', '/session/save', body, TOKEN);
    test('Save Session Progress (Canvas)', 'POST', '/session/save', r, [200, 201, 400, 401]);
  }

  {
    const r = await httpReq('GET', '/session/active/room_api_001', null, TOKEN);
    test('Active Sessions by Classroom', 'GET', '/session/active/:classroomId', r, [200, 401, 404]);
  }

  {
    const r = await httpReq('GET', '/session/active/desk/TCH-000001', null, TOKEN);
    test('Active Session by Desk ID', 'GET', '/session/active/desk/:deskId', r, [200, 401, 404]);
  }

  // ════════════ SECTION 4: AI ══════════════════
  console.log('\n━━━ SECTION 4: AI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const body = { message: 'What is photosynthesis? 2 lines only.' };
    const r = await httpReq('POST', '/ai/chat', body, TOKEN, 40000);
    test('AI Chat — Text Message', 'POST', '/ai/chat', r, [200, 401, 429, 503],
      r.b?.data?.reply ? `Reply: ${r.b.data.reply.slice(0,80)}…` : r.b?.message || '');
  }

  {
    const body = { prompt: 'Simple labeled diagram of a plant cell for students', size: '256x256' };
    const r = await httpReq('POST', '/ai/generate-image', body, TOKEN, 40000);
    test('AI Image Generation', 'POST', '/ai/generate-image', r, [200, 401, 429, 503],
      r.b?.data?.url ? `URL: ${String(r.b.data.url).slice(0,70)}…` : r.b?.message || '');
  }

  // ════════════ SECTION 5: YOUTUBE ════════════
  console.log('\n━━━ SECTION 5: YOUTUBE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('GET', '/youtube/search?query=photosynthesis+class+10&maxResults=5', null, TOKEN);
    test('YouTube Search', 'GET', '/youtube/search?query=photosynthesis', r, [200, 401, 403, 429],
      r.b?.data?.items ? `${r.b.data.items.length} videos found` : r.b?.message || '');
  }

  {
    const r = await httpReq('GET', '/youtube/video/9o6lxMKnhQQ', null, TOKEN);
    test('YouTube Video Details', 'GET', '/youtube/video/:videoId', r, [200, 401, 403, 404],
      r.b?.data?.snippet?.title || r.b?.message || '');
  }

  // ════════════ SECTION 6: NOTES ══════════════
  console.log('\n━━━ SECTION 6: NOTES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('GET', '/user/notes', null, TOKEN);
    test('List My Notes', 'GET', '/user/notes', r, [200, 401]);
  }

  {
    const r = await httpReq('GET', '/user/notes/stats', null, TOKEN);
    test('Notes Stats', 'GET', '/user/notes/stats', r, [200, 401, 404]);
  }

  {
    const body = {
      subjectId: 'subject_api_test',
      noteId: `note_${Date.now()}`,
      title: 'API Suite Test Note',
      canvasData: ['{"objects":[],"background":"#ffffff"}'],
      thumbnail: '',
      tags: ['test', 'api'],
    };
    const r = await httpReq('POST', '/user/notes', body, TOKEN);
    test('Save Note to Cloud', 'POST', '/user/notes', r, [200, 201, 400, 401]);
  }

  // ════════════ SECTION 7: FILES ══════════════
  console.log('\n━━━ SECTION 7: FILES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('GET', '/files', null, TOKEN);
    test('List Files', 'GET', '/files', r, [200, 401]);
  }

  // ════════════ SECTION 8: FOLDERS ════════════
  console.log('\n━━━ SECTION 8: FOLDERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('GET', '/folders', null, TOKEN);
    test('List Folders', 'GET', '/folders', r, [200, 401]);
  }

  let folderId = null;
  {
    const body = { name: `Test Folder ${Date.now()}` };
    const r = await httpReq('POST', '/folders', body, TOKEN);
    test('Create Folder', 'POST', '/folders', r, [200, 201, 401]);
    if (r.b?.data?._id) folderId = r.b.data._id;
  }

  if (folderId) {
    const r = await httpReq('DELETE', `/folders/${folderId}`, null, TOKEN);
    test('Delete Folder', 'DELETE', '/folders/:id', r, [200, 401, 404]);
  }

  // ════════════ SECTION 9: CLASSROOMS ═════════
  console.log('\n━━━ SECTION 9: CLASSROOMS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('GET', '/classrooms', null, TOKEN);
    test('List Classrooms', 'GET', '/classrooms', r, [200, 401]);
  }

  // ════════════ SECTION 10: NOTIFICATIONS ═════
  console.log('\n━━━ SECTION 10: NOTIFICATIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('GET', '/notifications', null, TOKEN);
    test('Get Notifications', 'GET', '/notifications', r, [200, 401]);
  }

  {
    const r = await httpReq('PUT', '/notifications/read-all', null, TOKEN);
    test('Mark All Notifications Read', 'PUT', '/notifications/read-all', r, [200, 401, 404]);
  }

  // ════════════ SECTION 11: DEVICES ═══════════
  console.log('\n━━━ SECTION 11: DEVICES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const body = { deviceId: `device_${Date.now()}`, platform: 'web', fcmToken: 'test_fcm_token_123' };
    const r = await httpReq('POST', '/devices/register', body, TOKEN);
    test('Register Device (Push Token)', 'POST', '/devices/register', r, [200, 201, 400, 401]);
  }

  // ════════════ SECTION 12: SYNC ══════════════
  console.log('\n━━━ SECTION 12: SYNC ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('GET', '/sync/status', null, TOKEN);
    test('Sync Status', 'GET', '/sync/status', r, [200, 401, 404]);
  }

  // ════════════ SECTION 13: LOGOUT ════════════
  console.log('\n━━━ SECTION 13: LOGOUT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  {
    const r = await httpReq('POST', '/auth/logout', {}, TOKEN);
    test('Logout', 'POST', '/auth/logout', r, [200, 401]);
  }

  {
    const r = await httpReq('GET', '/auth/me', null, TOKEN);
    test('POST-LOGOUT: /auth/me must be 401', 'GET', '/auth/me', r, [401],
      r.s === 401 ? '✅ Token properly blacklisted' : '❌ Token still valid!');
  }

  // ════════════ SUMMARY TABLE ══════════════════
  const pass = RESULTS.filter(r => r.status === 'PASS').length;
  const warn = RESULTS.filter(r => r.status === 'WARN').length;
  const fail = RESULTS.filter(r => r.status === 'FAIL').length;
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ✨ EduSync API Test Complete  —  ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(64)}`);
  console.log(`  Total APIs Tested : ${RESULTS.length}`);
  console.log(`  ✅ PASS           : ${pass}`);
  console.log(`  ⚠️  WARN           : ${warn}  (expected: auth/quota/not-found)`);
  console.log(`  ❌ FAIL           : ${fail}`);
  console.log(`  ⏱  Duration       : ${duration}s`);
  console.log(`${'─'.repeat(64)}`);
  console.log('\n  #  │ STATUS │ CODE │ METHOD │ ENDPOINT');
  console.log(`  ${'─'.repeat(58)}`);
  RESULTS.forEach(r => {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️ ' : '❌';
    console.log(`  ${String(r.num).padStart(2)} │ ${icon}    │ ${String(r.code).padStart(4)} │ ${r.method.padEnd(6)} │ ${r.path}`);
  });
  console.log(`\n${'═'.repeat(64)}\n`);

  if (fail > 0) {
    console.log('  ❌ Failed APIs:');
    RESULTS.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`     ${r.method} ${r.path} → HTTP ${r.code}`);
    });
    console.log('');
  }
}

run().catch(console.error);
