const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./src/models/User');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/edusync');
  
  const user = await User.findOne();
  
  const spreadUser = { ...user };
  
  console.log("Is Document?", spreadUser instanceof mongoose.Document);
  console.log("Has toSafeObject?", typeof spreadUser.toSafeObject === 'function');
  
  process.exit(0);
};

run();
