/**
 * createMockTestUsers.js
 * Creates a mock teacher and student for canvas notes testing.
 * Run: node scripts/createMockTestUsers.js
 * Delete: node scripts/createMockTestUsers.js --delete
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');

const MOCK_TEACHER = {
  name: 'Mock Teacher Test',
  email: 'mock.teacher.test@edusync.dev',
  password: 'Test@1234',
  role: 'teacher',
};
const MOCK_STUDENT = {
  name: 'Mock Student Test',
  email: 'mock.student.test@edusync.dev',
  password: 'Test@1234',
  role: 'student',
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to DB');

  const isDelete = process.argv.includes('--delete');

  if (isDelete) {
    // ── DELETE MODE ──────────────────────────────────
    const emails = [MOCK_TEACHER.email, MOCK_STUDENT.email];
    const res = await User.deleteMany({ email: { $in: emails } });
    console.log(`🗑️  Deleted ${res.deletedCount} mock user(s)`);

    // Also delete any files created by these users
    const File = require('../src/models/File');
    const users = []; // already deleted — use email-based approach
    await File.deleteMany({ 'ownerEmail': { $in: emails } }).catch(() => {});
    console.log('🗑️  Mock data cleanup complete');

  } else {
    // ── CREATE MODE ──────────────────────────────────
    const salt = await bcrypt.genSalt(10);

    for (const mock of [MOCK_TEACHER, MOCK_STUDENT]) {
      const existing = await User.findOne({ email: mock.email });
      if (existing) {
        console.log(`⚠️  ${mock.role} already exists: ${mock.email}`);
        console.log(`   ID: ${existing._id}`);
        continue;
      }

      const hashed = await bcrypt.hash(mock.password, salt);
      const user = await User.create({
        name: mock.name,
        email: mock.email,
        password: hashed,
        role: mock.role,
        isVerified: true,
        isActive: true,
      });
      console.log(`✅ Created ${mock.role}: ${mock.email} (ID: ${user._id})`);
    }

    console.log('\n📋 Login Credentials:');
    console.log('─────────────────────────────────────────');
    console.log(`TEACHER  → ${MOCK_TEACHER.email} / ${MOCK_TEACHER.password}`);
    console.log(`STUDENT  → ${MOCK_STUDENT.email} / ${MOCK_STUDENT.password}`);
    console.log('─────────────────────────────────────────');
    console.log('\nLogin endpoint: POST /auth/login-password');
    console.log('Delete when done: node scripts/createMockTestUsers.js --delete\n');
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
