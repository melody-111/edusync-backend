const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { saveNote, deleteFile } = require('./src/controllers/fileController');
const File = require('./src/models/File');
const User = require('./src/models/User');
const Folder = require('./src/models/Folder');

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  const user = await User.findOne({ email: 'sudhanshusonkarsunsor@gmail.com' });
  if (!user) throw new Error("User not found");
  console.log('Found user:', user._id);

  // 1. Create a dummy folder
  const folder = await Folder.create({ name: 'Test Folder', ownerId: user._id, ownerRole: 'teacher' });
  console.log('Created folder:', folder._id);

  // 2. Create Note using the same payload format as DashboardScreen / TeachingScreen
  // req object mock
  const req = {
    user: user,
    body: {
      title: 'Test Create Note',
      canvasData: '{"version":"5.3.0","objects":[]}',
      folderId: folder._id.toString()
    }
  };
  
  let jsonCalled = false;
  let responseData = null;
  const res = {
    status: (code) => res,
    json: (data) => { jsonCalled = true; responseData = data; return res; }
  };

  try {
    await saveNote(req, res);
    console.log('saveNote Response:', responseData);
  } catch (err) {
    console.error('saveNote Error:', err);
  }

  // 3. Delete Note
  if (responseData && responseData.data && responseData.data.file) {
    const fileId = responseData.data.file._id;
    console.log('Attempting to delete file:', fileId);
    
    const delReq = { user: user, params: { id: fileId } };
    const delRes = { status: (c) => delRes, json: (d) => { console.log('deleteFile Response:', d); return delRes; }};
    await deleteFile(delReq, delRes);
  }

  // Cleanup
  await Folder.findByIdAndDelete(folder._id);
  mongoose.connection.close();
}
run().catch(console.error);
