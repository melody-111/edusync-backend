const mongoose = require('mongoose');
const dotenv = require('dotenv');
const File = require('./src/models/File');
const { downloadCanvasData } = require('./src/services/cloudStorage');

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const file = await File.findById('6a74b362e5d171b188b3b219').lean();
  console.log("File found:", file.title);
  
  if (!file.canvasData && file.cloudUrl) {
    console.log("Attempting to download from cloud:", file.cloudUrl);
    try {
      const cloudContent = await downloadCanvasData(file.cloudUrl);
      console.log("Downloaded cloudContent length:", cloudContent ? cloudContent.length : 0);
      if (cloudContent) {
        console.log("Preview:", cloudContent.substring(0, 100));
      } else {
        console.log("downloadCanvasData returned null/empty!");
      }
    } catch (e) {
      console.error("Download failed:", e);
    }
  } else {
    console.log("No cloud URL or already has canvasData.");
  }
  mongoose.connection.close();
}
run();
