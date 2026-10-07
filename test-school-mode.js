const axios = require('axios');
const io = require('socket.io-client');

async function runTest() {
  try {
    // 1. Login Teacher
    const tLogin = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'sudhanshusonkar83@gmail.com',
      password: 'sssssss'
    });
    const teacherToken = tLogin.data.data.accessToken;
    const teacherId = tLogin.data.data.user._id;
    console.log('Teacher Logged In:', tLogin.data.data.user.name);

    // 2. Login Student
    const sLogin = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'pandeydivyansh574@gmail.com',
      password: 'sssssss'
    });
    const studentToken = sLogin.data.data.accessToken;
    const studentClass = sLogin.data.data.user.className;
    console.log('Student Logged In:', sLogin.data.data.user.name, '| Class:', studentClass);

    // 3. Connect Student Socket
    const socket = io('http://localhost:5000', {
      auth: { token: studentToken }
    });

    socket.on('connect', () => {
      console.log('Student Socket Connected! ID:', socket.id);
      
      socket.on('class:started', (data) => {
        console.log('\n=======================================');
        console.log('✅ SUCCESS! Student received "class:started" event!');
        console.log('Event Data:', data);
        console.log('=======================================\n');
        process.exit(0);
      });

      // 4. Teacher Starts Session via API
      setTimeout(async () => {
        try {
          console.log('Teacher starting session...');
          const sessionRes = await axios.post('http://localhost:5000/api/session/start', {
            subjectId: 'physics_101',
            subjectName: 'Physics',
            className: studentClass || '10', // Target student's class
            section: 'A'
          }, {
            headers: { Authorization: `Bearer ${teacherToken}` }
          });
          console.log('Session started! ID:', sessionRes.data.data.session._id);
        } catch (e) {
          console.error('Failed to start session:', e.response?.data || e.message);
        }
      }, 2000);
    });
    
    // Timeout
    setTimeout(() => {
      console.log('❌ FAILED: Student did not receive class:started within 10s');
      process.exit(1);
    }, 12000);

  } catch (err) {
    console.error('Test Error:', err.response?.data || err.message);
    process.exit(1);
  }
}
runTest();
