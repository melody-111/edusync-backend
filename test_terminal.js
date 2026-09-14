require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const BASE_URL = 'http://localhost:5001';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  
  const user = await db.collection('users').findOne({ role: 'student', isActive: true });
  if (!user) {
    console.log('No active student found in DB. Test aborted.');
    process.exit(1);
  }

  const token = jwt.sign(
    { sub: user._id.toString(), role: 'student', type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  console.log(`\n[1] Web App initializing Terminal session...`);
  const initRes = await axios.get(`${BASE_URL}/auth/terminal/init?role=student`);
  const { terminalId, qrToken } = initRes.data.data;
  console.log(`Received Terminal ID: ${terminalId}`);

  console.log(`\n[2] Mobile App syncing terminal with user ${user.email}...`);
  try {
    const syncRes = await axios.post(`${BASE_URL}/auth/terminal/sync`, {
      terminalId,
      qrToken
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`Sync status: ${syncRes.status}. Output: ${syncRes.data.message}`);
  } catch (err) {
    console.log(`Sync status: ${err.response.status}. Output: ${err.response.data.message}`);
  }

  console.log(`\n[3] Web App checking terminal status...`);
  const statusRes = await axios.get(`${BASE_URL}/auth/terminal/status/${terminalId}`);
  console.log(`Final Status: ${statusRes.data.data.status}`);
  if (statusRes.data.data.status === 'synced' && statusRes.data.data.accessToken) {
    console.log('✅ TERMINAL SYNC FLOW PASSED SUCCESSFULLY!');
  } else {
    console.log('❌ TERMINAL SYNC FLOW FAILED!');
  }

  process.exit(0);
}

run().catch(err => {
  console.error('Test Failed:', err.response ? err.response.data : err.message);
  process.exit(1);
});
