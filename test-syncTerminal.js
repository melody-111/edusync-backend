const mongoose = require('mongoose');
require('dotenv').config();
const { syncTerminal } = require('./src/controllers/authController');
const User = require('./src/models/User');
const TerminalSession = require('./src/models/TerminalSession');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/edusync');
  
  const user = await User.create({
    email: 'testsync2@test.com',
    name: 'Test Sync',
    role: 'teacher',
    isActive: true
  });

  const term = await TerminalSession.create({
    terminalId: 'mock123', qrToken: 'mockToken', targetRole: 'teacher', expiresAt: new Date(Date.now() + 100000)
  });

  const req = {
    tokenPayload: { sub: user._id },
    body: { terminalId: 'mock123', qrToken: 'mockToken' }
  };
  const res = {
    status: (code) => { console.log('Status:', code); return res; },
    json: (data) => console.log(JSON.stringify(data, null, 2)),
  };
  const next = (err) => {
    console.error("NEXT CAUGHT ERROR:", err);
  }

  await syncTerminal(req, res, next);

  await User.findByIdAndDelete(user._id);
  await TerminalSession.findByIdAndDelete(term._id);
  process.exit(0);
};

run();
