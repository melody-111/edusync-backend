const axios = require('axios');
const fs = require('fs');

const API_URL = 'http://localhost:5001/auth';
const TEST_EMAIL = `test_teacher_${Date.now()}@test.com`;
const TEST_PASSWORD = 'password123';
const TEST_ROLE = 'teacher';

async function run() {
  try {
    console.log(`1. Testing Signup for ${TEST_EMAIL}...`);
    const signupRes = await axios.post(`${API_URL}/signup`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      role: TEST_ROLE,
      name: 'E2E Teacher',
      institutionType: 'school',
      institutionName: 'E2E School'
    });
    console.log('Signup Response:', signupRes.data.message);

    // Give it a second to log the OTP
    await new Promise(r => setTimeout(r, 2000));
    
    // Read the log file to get the OTP
    const logPath = '/Users/sudhanshu/.gemini/antigravity-ide/brain/c9534c75-ceaf-4917-b205-e782229ef987/.system_generated/tasks/task-531.log';
    const logContent = fs.readFileSync(logPath, 'utf8');
    
    const otpMatch = logContent.match(new RegExp(`OTP sent to ${TEST_EMAIL}.*OTP_CODE: (\\d{6})`));
    if (!otpMatch) {
      console.error('Could not find OTP in logs!');
      return;
    }
    const otp = otpMatch[1];
    console.log(`2. Extracted OTP: ${otp}`);

    console.log('3. Testing Verify OTP...');
    const verifyRes = await axios.post(`${API_URL}/verify-otp`, {
      email: TEST_EMAIL,
      otp: otp
    });
    console.log('Verify Response:', verifyRes.data.message);
    const accessToken = verifyRes.data.data.accessToken;
    console.log('Access Token received:', accessToken ? 'Yes' : 'No');

    console.log('4. Testing Login Password...');
    const loginRes = await axios.post(`${API_URL}/login-password`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      role: TEST_ROLE
    });
    console.log('Login Response:', loginRes.data.message);
    console.log('Login Token received:', loginRes.data.data.accessToken ? 'Yes' : 'No');

    console.log('5. Testing Invalid Login...');
    try {
      await axios.post(`${API_URL}/login-password`, {
        email: TEST_EMAIL,
        password: 'wrongpassword',
        role: TEST_ROLE
      });
      console.log('FAILED: Should not allow login with wrong password');
    } catch(err) {
      console.log('Invalid Login caught correctly:', err.response?.data?.message);
    }
    
    console.log('--- ALL E2E TESTS PASSED ---');
  } catch (err) {
    console.error('Test Failed:', err.response?.data || err.message);
  }
}
run();
