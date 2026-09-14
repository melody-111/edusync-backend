const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const path = require('path');
const User = require('../src/models/User');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // Strictly load the env

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/edusync';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const PORT = process.env.PORT || 5000;
const SERVER_URL = `http://localhost:${PORT}`;

async function runTest() {
  console.log('--- STARTING LIVE CLASS SIMULATION ---');

  // 1. Connect to DB
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB Connection failed', err);
    process.exit(1);
  }

  // 2. Create Mock Users
  console.log('🛠 Creating mock teacher and student...');
  const teacherEmail = `teacher_${Date.now()}@test.com`;
  const studentEmail = `student_${Date.now()}@test.com`;

  const teacher = await User.create({
    name: 'Dr. Test Faculty',
    email: teacherEmail,
    role: 'teacher',
    institutionName: 'Testing Institute',
    institutionType: 'university',
    subjectName: 'Advanced Physics',
    course: 'B.Tech',
    branch: 'Computer Science',
    semester: '5'
  });

  const student = await User.create({
    name: 'Test Student',
    email: studentEmail,
    role: 'student',
    institutionName: 'Testing Institute',
    institutionType: 'university',
    course: 'B.Tech',
    branch: 'Computer Science',
    semester: '5'
  });

  console.log(`✅ Mock Teacher Created: ${teacher.name} (${teacher.subjectName})`);
  console.log(`✅ Mock Student Created: ${student.name} (${student.branch}, Sem ${student.semester})`);

  // 3. Generate JWTs
  const teacherToken = jwt.sign({ id: teacher._id, role: teacher.role }, JWT_SECRET);
  const studentToken = jwt.sign({ id: student._id, role: student.role }, JWT_SECRET);

  // 4. Connect WebSockets
  console.log(`🔌 Connecting to WebSocket server at ${SERVER_URL}...`);
  const teacherSocket = io(SERVER_URL, {
    auth: { token: teacherToken },
    transports: ['websocket', 'polling'],
    reconnection: false
  });

  const studentSocket = io(SERVER_URL, {
    auth: { token: studentToken },
    transports: ['websocket', 'polling'],
    reconnection: false
  });

  let testPassed = false;

  studentSocket.on('connect_error', (err) => console.log('Student connection error:', err));
  teacherSocket.on('connect_error', (err) => console.log('Teacher connection error:', err));

  studentSocket.on('connect', () => {
    console.log('✅ Student Socket Connected');
  });

  teacherSocket.on('connect', () => {
    console.log('✅ Teacher Socket Connected');
    
    // Simulate teacher clicking "Go Live" after 1 second
    setTimeout(() => {
      console.log('🚀 Teacher emitting "class:started"...');
      teacherSocket.emit('class:started', {
        roomId: `live_${teacher._id}`,
        subject: teacher.subjectName,
        sessionId: 'test_session_id',
        isBroadcasting: true,
        targetType: 'university',
        institutionName: teacher.institutionName,
        branch: teacher.branch,
        year: teacher.year,
        semester: teacher.semester
      });
    }, 1000);
  });

  // 5. Student Listens for Notification
  studentSocket.on('class:started', (data) => {
    console.log('\n🎉 [SUCCESS] Student received "class:started" event!');
    console.log('📦 Payload Received:', data);
    
    if (data.subject === 'Advanced Physics' && data.institutionName === 'Testing Institute') {
       console.log('✅ Subject and Criteria Matched Perfectly!');
       testPassed = true;
    } else {
       console.log('❌ Payload data did not match expected criteria.');
    }
  });

  // 6. Cleanup after a few seconds
  setTimeout(async () => {
    console.log('\n🧹 Cleaning up test users...');
    await User.deleteOne({ email: teacherEmail });
    await User.deleteOne({ email: studentEmail });
    teacherSocket.disconnect();
    studentSocket.disconnect();
    await mongoose.disconnect();
    
    if (testPassed) {
      console.log('🏁 TEST COMPLETED: ALL PASS');
      process.exit(0);
    } else {
      console.log('🏁 TEST COMPLETED: FAIL (Student did not receive broadcast)');
      process.exit(1);
    }
  }, 3000);
}

runTest();
