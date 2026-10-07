const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/edusync');
const User = require('./src/models/User');
async function run() {
  const u = await User.findOne({ email: 'pandeydivyansh574@gmail.com' });
  console.log(u);
  process.exit(0);
}
run();
