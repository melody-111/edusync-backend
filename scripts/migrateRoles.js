const mongoose = require('mongoose');
const User = require('../src/models/User');
require('dotenv').config();

async function migrateSuperAdmins() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
    
    const result = await User.updateMany({ role: 'super_admin' }, { $set: { role: 'admin' } });
    console.log(`Updated ${result.modifiedCount} users from super_admin to admin`);
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

migrateSuperAdmins();
