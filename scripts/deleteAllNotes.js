'use strict';

/**
 * One-time script: Delete ALL notes from MongoDB + Cloudinary
 * Run: node scripts/deleteAllNotes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const File = require('../src/models/File');

async function main() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected!');

  // Find all notes with cloudPublicId
  const notesWithCloud = await File.find({ cloudPublicId: { $nin: [null, ''] } }).lean();
  console.log(`Found ${notesWithCloud.length} notes with Cloudinary assets. Deleting from Cloudinary...`);

  let cloudDeleted = 0;
  for (const note of notesWithCloud) {
    try {
      const resourceType = note.cloudUrl && note.cloudUrl.includes('/image/') ? 'image' : 'raw';
      await cloudinary.uploader.destroy(note.cloudPublicId, { resource_type: resourceType });
      cloudDeleted++;
    } catch (e) {
      console.warn(`  Failed to delete cloud asset ${note.cloudPublicId}:`, e.message);
    }
  }
  console.log(`  Cloudinary: ${cloudDeleted}/${notesWithCloud.length} assets deleted.`);

  // Also delete thumbnail assets
  const notesWithThumb = await File.find({ thumbnailUrl: { $nin: [null, ''] } }).lean();
  for (const note of notesWithThumb) {
    try {
      const publicId = `edusync/thumbnails/${note.ownerId}/thumb_${note._id}`;
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch (e) { /* ignore */ }
  }

  // Now delete ALL file documents from MongoDB
  const result = await File.deleteMany({});
  console.log(`MongoDB: Deleted ${result.deletedCount} file documents.`);

  console.log('\n✅ All notes cleared successfully!');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
