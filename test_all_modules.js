const axios = require('axios');

const BASE_URL = 'http://localhost:5001';

const tests = [
  { module: 'Auth', method: 'get', path: '/auth/terminal/init' },
  { module: 'Admin', method: 'get', path: '/admin/stats' },
  { module: 'Live Sessions', method: 'get', path: '/session/live' },
  { module: 'Classrooms', method: 'get', path: '/classroom' },
  { module: 'Files', method: 'get', path: '/files' },
  { module: 'Folders', method: 'get', path: '/folder' },
  { module: 'Devices', method: 'get', path: '/devices' },
  { module: 'Free Study', method: 'get', path: '/free-study' },
  { module: 'AI', method: 'post', path: '/ai/chat', data: { message: 'hello' } },
  { module: 'Notes', method: 'post', path: '/notes/save', data: {} },
  { module: 'Sync', method: 'post', path: '/sync/offline-records', data: {} },
  { module: 'Notifications', method: 'get', path: '/notification' },
  { module: 'YouTube', method: 'get', path: '/youtube/search?q=math' },
  { module: 'Test Email', method: 'post', path: '/test-email/send', data: { to: 'test@example.com' } },
];

async function runTests() {
  console.log('=========================================');
  console.log('🚀 DIGITAL CLASSROOM - MODULE TEST SUITE');
  console.log('=========================================\n');
  
  let passed = 0;

  for (const t of tests) {
    try {
      const url = `${BASE_URL}${t.path}`;
      let res;
      if (t.method === 'get') {
        res = await axios.get(url, { validateStatus: () => true });
      } else {
        res = await axios.post(url, t.data, { validateStatus: () => true });
      }
      
      if (res.status !== 404) {
        console.log(`✅ [${t.module}] Active -> ${t.path} (Status: ${res.status})`);
        passed++;
      } else {
        console.log(`❌ [${t.module}] Missing -> ${t.path} (Status: 404)`);
      }
      
    } catch (err) {
      console.log(`❌ [${t.module}] Network Error -> ${t.path}: ${err.message}`);
    }
  }

  console.log('\n=========================================');
  console.log(`🏁 TEST COMPLETE: ${passed}/${tests.length} Modules Active`);
  console.log('=========================================');
}

runTests();
