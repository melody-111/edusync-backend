const mongoose = require('mongoose');
const dotenv = require('dotenv');
const File = require('./src/models/File');
const User = require('./src/models/User');

dotenv.config();
async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.findOne({ email: 'sudhanshusonkarsunsor@gmail.com' });
  const files = await File.find({ ownerId: user._id }).sort({ createdAt: -1 }).limit(5);
  console.log("Recent files:", files.map(f => ({ id: f._id, title: f.title, folderId: f.folderId })));
  mongoose.connection.close();
}
run();
