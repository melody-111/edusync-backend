const mongoose = require('mongoose');
const dotenv = require('dotenv');
const File = require('./src/models/File');
const User = require('./src/models/User');

dotenv.config();
async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.findOne({ email: 'sudhanshusonkarsunsor@gmail.com' });
  const files = await File.find({ ownerId: user._id }).sort({ updatedAt: -1 }).limit(3);
  files.forEach(f => {
    console.log(`\n--- Note: ${f.title} (ID: ${f._id}) ---`);
    console.log(`canvasData Length: ${f.canvasData ? f.canvasData.length : 0} bytes`);
    console.log(`Cloud URL: ${f.cloudUrl || 'None'}`);
    if (f.canvasData) {
      console.log(`Preview: ${f.canvasData.substring(0, 150)}...`);
    } else {
      console.log("No canvas data found in DB!");
    }
  });
  mongoose.connection.close();
}
run();
