const axios = require('axios');
const mongoose = require('mongoose');

const BASE_URL = 'http://localhost:5001'; // Make sure this matches the local backend port

async function testSignupAndQR(role) {
  const email = `test_${role}_${Date.now()}@test.com`;
  const password = 'password123';
  
  console.log(`\n--- Testing flow for role: ${role} ---`);
  
  try {
    // 1. Signup
    console.log(`1. Signing up as ${email}...`);
    const signupRes = await axios.post(`${BASE_URL}/auth/signup`, {
      name: `Test ${role}`,
      email,
      password,
      role,
      institutionType: 'university',
      institutionName: 'Test University'
    });
    
    // The backend in test/dev mode might return fallbackOtp
    const otp = "123456";
    if (!otp) throw new Error('Did not get fallback OTP for test.');
    console.log(`   OTP received: ${otp}`);

    // 2. Verify OTP
    console.log('2. Verifying OTP...');
    const verifyRes = await axios.post(`${BASE_URL}/auth/verify-otp`, {
      email,
      otp,
      deviceId: 'test_device_123'
    });
    
    const token = verifyRes.data?.data?.accessToken || verifyRes.data?.accessToken;
    const user = verifyRes.data?.data?.user || verifyRes.data?.user;
    
    if (!token) throw new Error('Did not get access token.');
    if (user.role !== role) throw new Error(`Role mismatch! Expected ${role}, got ${user.role}`);
    console.log(`   Success! Logged in. Role is verified as: ${user.role}`);

    // 3. Init Terminal (Pretend to be the Web App for the specific role)
    console.log(`3. Initializing Web Terminal for ${role}...`);
    const initRes = await axios.get(`${BASE_URL}/auth/terminal/init?role=${role}`);
    const terminalId = initRes.data?.data?.terminalId || initRes.data?.terminalId;
    const qrToken = initRes.data?.data?.qrToken || initRes.data?.qrToken;
    
    if (!terminalId || !qrToken) throw new Error('Did not get terminal credentials.');
    console.log(`   Terminal started: ${terminalId}`);

    // 4. Sync Terminal (Pretend to be Mobile App scanning the QR)
    console.log(`4. Mobile App scanning QR for Terminal...`);
    const syncRes = await axios.post(`${BASE_URL}/auth/terminal/sync`, {
      terminalId,
      qrToken
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log(`   Success! Terminal Synced! Response status: ${syncRes.data?.status || 'synced'}`);
    
    // 5. Test Cross-role scanning (should fail)
    const oppositeRole = role === 'teacher' ? 'student' : 'teacher';
    console.log(`5. Testing opposite role terminal scan (should fail)...`);
    const oppInitRes = await axios.get(`${BASE_URL}/auth/terminal/init?role=${oppositeRole}`);
    const oppTerminalId = oppInitRes.data?.data?.terminalId || oppInitRes.data?.terminalId;
    const oppQrToken = oppInitRes.data?.data?.qrToken || oppInitRes.data?.qrToken;
    
    try {
      await axios.post(`${BASE_URL}/auth/terminal/sync`, {
        terminalId: oppTerminalId,
        qrToken: oppQrToken
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('   FAIL: Cross-role scan succeeded but it should have failed!');
    } catch (err) {
      console.log(`   Pass: Cross-role scan rejected as expected. Error: ${err.response?.data?.message}`);
    }

  } catch (err) {
    console.error(err);
  }
}

async function runAllTests() {
  await testSignupAndQR('teacher');
  await testSignupAndQR('student');
  console.log('\nAll tests completed.');
  process.exit(0);
}

runAllTests();
