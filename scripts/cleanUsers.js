'use strict';
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

async function cleanUsers() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected!');

    const db = mongoose.connection.db;
    
    // Delete all users
    const userResult = await db.collection('users').deleteMany({});
    console.log(`✅ Deleted ${userResult.deletedCount} users`);
    
    // Delete all terminal sessions
    const termResult = await db.collection('terminalsessions').deleteMany({});
    console.log(`✅ Deleted ${termResult.deletedCount} terminal sessions`);
    
    // Delete refresh tokens if collection exists
    try {
      const tokenResult = await db.collection('refreshtokens').deleteMany({});
      console.log(`✅ Deleted ${tokenResult.deletedCount} refresh tokens`);
    } catch (e) {
      console.log('No refreshtokens collection found (OK)');
    }

    console.log('\n🎉 Database cleaned! All users removed. Ready for fresh signup.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

cleanUsers();
