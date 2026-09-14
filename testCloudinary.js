require('dotenv').config();
const { uploadCanvasData, downloadCanvasData, isCloudEnabled } = require('./src/services/cloudStorage');

const run = async () => {
  console.log('Cloud Enabled:', isCloudEnabled());
  if (!isCloudEnabled()) process.exit(1);

  const testData = JSON.stringify([{ test: 'Hello Cloudinary!' }]);
  console.log('Original Data:', testData);

  const result = await uploadCanvasData(testData, 'test_user_123', 'test_note_456');
  console.log('Upload Result:', result);

  if (result?.cloudUrl) {
    const downloaded = await downloadCanvasData(result.cloudUrl);
    console.log('Downloaded Data:', downloaded);
    console.log('Is Match:', downloaded === testData);
  } else {
    console.log('Upload failed, no cloudUrl');
  }
};

run().catch(console.error);
