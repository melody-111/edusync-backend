const mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/edusync', { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    const User = require('./src/models/User');
    const File = require('./src/models/File');
    const user = await User.findOne({ email: 'sudhanshusonkarsunsor@gmail.com' });
    if (!user) { console.log('User not found'); process.exit(0); }
    const files = await File.find({ ownerId: user._id });
    console.log('User files:', files.length);
    console.log(files.map(f => ({ title: f.title, folderId: f.folderId, canvasDataLen: f.canvasData?.length, cloudUrl: f.cloudUrl })));
    process.exit(0);
  });
