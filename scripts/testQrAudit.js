require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const { generateTokenPair } = require('../src/utils/jwt');
const User = require('../src/models/User');
const TerminalSession = require('../src/models/TerminalSession');

const BASE_URL = 'http://localhost:5001';

async function runAudit() {
  console.log('--- QR Code Authentication Audit ---');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  // Create test user
  const user = await User.create({
    email: `test_audit_${Date.now()}@test.com`,
    password: 'password123',
    name: 'Audit User',
    role: 'teacher',
    isVerified: true,
    isActive: true,
  });
  
  const { accessToken } = generateTokenPair(user);
  
  try {
    // 1. Initializing Terminal
    console.log('[Test 1] Terminal Initialization');
    const initRes = await axios.get(`${BASE_URL}/auth/terminal/init?role=teacher`);
    const { terminalId, qrCodeDataUrl } = initRes.data.data;
    
    // Validate no token leakage
    if (initRes.data.data.qrToken) {
      throw new Error('SECURITY VULNERABILITY: qrToken leaked in init API response');
    }
    console.log('✅ Passed: No token leakage in init API');

    // Extract qrToken from DB
    const terminalDoc = await TerminalSession.findOne({ terminalId });
    const qrToken = terminalDoc.qrToken;

    // 2. Invalid QR Scan
    console.log('[Test 2] Invalid QR Scan');
    try {
      await axios.post(`${BASE_URL}/auth/terminal/sync`, 
        { terminalId, qrToken: 'invalid-token-123' },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      throw new Error('Failed: Invalid QR was accepted');
    } catch (err) {
      if (err.response?.status === 400) {
         console.log('✅ Passed: Invalid QR rejected');
      } else {
         throw err;
      }
    }

    // 3. Valid Scan
    console.log('[Test 3] Valid QR Scan');
    const syncRes = await axios.post(`${BASE_URL}/auth/terminal/sync`, 
      { terminalId, qrToken },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (syncRes.data.status === 'success') {
       console.log('✅ Passed: Valid QR accepted');
    }

    // 4. Replay Attack / Duplicate Scan
    console.log('[Test 4] Replay Attack Prevention');
    try {
      await axios.post(`${BASE_URL}/auth/terminal/sync`, 
        { terminalId, qrToken },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      throw new Error('SECURITY VULNERABILITY: Replay Attack succeeded (Duplicate scan allowed)');
    } catch (err) {
      if (err.response?.status === 400 && err.response?.data?.message.includes('expired or already used')) {
         console.log('✅ Passed: Replay attack mitigated. Token is marked as used.');
      } else {
         throw new Error(`Failed: Replay attack rejected for wrong reason: ${err.message}`);
      }
    }
    
    // 5. Polling Check for Tokens
    console.log('[Test 5] Polling for session tokens');
    const pollRes = await axios.get(`${BASE_URL}/auth/terminal/status/${terminalId}`);
    if (pollRes.data.data.status === 'synced' && pollRes.data.data.accessToken) {
       console.log('✅ Passed: Tokens delivered successfully via polling');
    } else {
       throw new Error('Failed: Tokens not delivered during polling');
    }

    console.log('\\n--- ALL TESTS PASSED SUCCESSFULLY ---');
  } catch (err) {
    console.error('\\n❌ AUDIT FAILED:', err.message || err.response?.data || err);
  } finally {
    await User.findByIdAndDelete(user._id);
    await mongoose.disconnect();
    process.exit(0);
  }
}

runAudit();
