const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./src/models/User'); // Assuming this exists
require('dotenv').config();

async function insertUsers() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/edusync');
  console.log('Connected to DB');

  const passwordHash = await bcrypt.hash('ssssss', 10);

  const teacher = await User.findOneAndUpdate(
    { email: 'sudhanshusonkar210@gmail.com' },
    { name: 'Sudhanshu Teacher', password: passwordHash, role: 'teacher' },
    { upsert: true, new: true }
  );
  
  const student = await User.findOneAndUpdate(
    { email: 'sudhanshusonkar83@gmail.com' },
    { name: 'Sudhanshu Student', password: passwordHash, role: 'student' },
    { upsert: true, new: true }
  );

  console.log('Teacher:', teacher.email, teacher.role);
  console.log('Student:', student.email, student.role);
  
  mongoose.disconnect();
}

insertUsers().catch(console.error);
