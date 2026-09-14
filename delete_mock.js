const mongoose = require('mongoose');
const User = require('./src/models/User'); // Assuming this exists
require('dotenv').config();

async function deleteMock() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/edusync');
  
  await User.deleteOne({ email: 'sudhanshusonkar210@gmail.com' });
  await User.deleteOne({ email: 'sudhanshusonkar83@gmail.com' });
  await User.deleteOne({ email: 'mockteacher@test.com' });
  await User.deleteOne({ email: 'mockstudent@test.com' });

  console.log('Removed all mock/test users from local DB');
  mongoose.disconnect();
}

deleteMock().catch(console.error);
