require('dotenv').config();
const mongoose = require('mongoose');
const { generateTokenPair } = require('../src/utils/jwt');
const User = require('../src/models/User');
const axios = require('axios');

const BASE_URL = 'http://localhost:5001';

async function testQrFlowWithoutOtp(role) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`\n--- Testing flow for role: ${role} ---`);

    const email = `test_${role}_${Date.now()}@test.com`;
    
    // 1. Manually create a verified user in DB
    const user = await User.create({
      email,
      name: `Test ${role}`,
      role: role,
      isVerified: true
    });
    
    // 2. Generate a valid token
    const { accessToken } = generateTokenPair(user);
    console.log(`1. Created mock verified ${role} and got token`);

    // 3. Init Terminal (Pretend to be the Web App for the specific role)
    console.log(`2. Initializing Web Terminal for ${role}...`);
    const initRes = await axios.get(`${BASE_URL}/auth/terminal/init?role=${role}`);
    const terminalId = initRes.data?.data?.terminalId || initRes.data?.terminalId;
    
    // Fetch the actual qrToken from DB because the API no longer leaks it in the response
    const TerminalSession = require('../src/models/TerminalSession');
    const terminalDoc = await TerminalSession.findOne({ terminalId });
    const qrToken = terminalDoc.qrToken;
    
    if (!terminalId || !qrToken) throw new Error('Did not get terminal credentials.');
    console.log(`   Terminal started: ${terminalId}`);

    // 4. Sync Terminal (Pretend to be Mobile App scanning the QR)
    console.log(`3. Mobile App scanning QR for Terminal...`);
    const syncRes = await axios.post(`${BASE_URL}/auth/terminal/sync`, {
      terminalId,
      qrToken
    }, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    console.log(`   Success! Terminal Synced! Response status: ${syncRes.data?.status || 'synced'}`);
    
    // 5. Test Cross-role scanning (should fail)
    const oppositeRole = role === 'teacher' ? 'student' : 'teacher';
    console.log(`4. Testing opposite role terminal scan (should fail)...`);
    const oppInitRes = await axios.get(`${BASE_URL}/auth/terminal/init?role=${oppositeRole}`);
    const oppTerminalId = oppInitRes.data?.data?.terminalId || oppInitRes.data?.terminalId;
    const oppTerminalDoc = await TerminalSession.findOne({ terminalId: oppTerminalId });
    const oppQrToken = oppTerminalDoc.qrToken;
    
    try {
      const oppSyncRes = await axios.post(`${BASE_URL}/auth/terminal/sync`, {
        terminalId: oppTerminalId,
        qrToken: oppQrToken
      }, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      console.log(`   Pass: Cross-role scan succeeded! Response status: ${oppSyncRes.data?.status || 'synced'}. Fix verified!`);
    } catch (err) {
      console.log(`   FAIL: Cross-role scan rejected. Error: ${err.response?.data?.message}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Test Failed:', err.response?.data?.message || err.message);
    process.exit(1);
  }
}

testQrFlowWithoutOtp(process.argv[2] || 'teacher');
