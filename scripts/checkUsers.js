// Quick test to verify the backend is returning correct user roles
const https = require('https');

const BACKEND = 'https://edusync-backend-application.onrender.com';

// Test admin endpoint
const adminToken = process.argv[2];

if (!adminToken) {
  console.log('Usage: node scripts/checkUsers.js <admin_token>');
  console.log('Get the admin_token from localStorage in the admin dashboard (admin_token key)');
  process.exit(0);
}

const options = {
  hostname: 'edusync-backend-application.onrender.com',
  path: '/admin/users',
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${adminToken}`,
    'x-admin-secret': 'EDUSYNC_ADMIN_2024'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const users = parsed?.data?.users || [];
      console.log(`\nTotal Users: ${users.length}`);
      users.forEach(u => {
        console.log(`  - ${u.name} (${u.email}) → role: ${u.role}`);
      });
    } catch(e) {
      console.log('Response:', data.substring(0, 300));
    }
  });
});

req.on('error', e => console.error('Error:', e.message));
req.end();
