/**
 * ============================================================
 * FULL CLEANUP SCRIPT
 * Deletes ALL users, notes, folders, sessions, files
 * from MongoDB AND Cloudinary.
 * ============================================================
 * Run: node cleanup_all.js
 */

const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

// ─── CONFIG ──────────────────────────────────────────────────
const MONGODB_URI = 'mongodb+srv://Divyansh:Divyansh@trial.qjmankx.mongodb.net/digital_classroom?retryWrites=true&w=majority';

cloudinary.config({
  cloud_name: 'deugl7xsi',
  api_key: '131961553192788',
  api_secret: '-qiTsE0h6D2LoFOiK5RCxrpVbJc',
});

// ─── COLLECTIONS TO WIPE ─────────────────────────────────────
const COLLECTIONS_TO_DELETE = [
  'users',
  'files',
  'folders',
  'sessions',
  'sessionparticipants',
  'strokebatches',
  'pages',
  'mediasessions',
  'activitylogs',
  'notifications',
  'assignments',
  'exportedfiles',
  'syncqueues',
  'terminalsessions',
  'subjects',
  'subscriptions',
  'devices',
  'classrooms',
];

async function deleteCloudinaryAssets() {
  console.log('\n🌩️  Deleting Cloudinary assets...');
  let deleted = 0;
  let nextCursor = undefined;

  try {
    do {
      const result = await cloudinary.api.resources({
        type: 'upload',
        max_results: 500,
        next_cursor: nextCursor,
      });

      const publicIds = result.resources.map((r) => r.public_id);

      if (publicIds.length > 0) {
        for (let i = 0; i < publicIds.length; i += 100) {
          const batch = publicIds.slice(i, i + 100);
          await cloudinary.api.delete_resources(batch);
          deleted += batch.length;
          process.stdout.write(`   Deleted ${deleted} assets so far...\r`);
        }
      }

      nextCursor = result.next_cursor;
    } while (nextCursor);

    console.log(`\n   ✅ Cloudinary: Deleted ${deleted} assets`);
  } catch (err) {
    console.error('   ❌ Cloudinary error:', err.message);
  }

  try {
    const foldersResult = await cloudinary.api.root_folders();
    for (const folder of foldersResult.folders || []) {
      try {
        await cloudinary.api.delete_folder(folder.path);
        console.log(`   🗂️  Deleted Cloudinary folder: ${folder.path}`);
      } catch (e) {}
    }
  } catch (err) {
    console.warn('   ⚠️  Could not delete Cloudinary folders:', err.message);
  }
}

async function deleteMongoData(db) {
  console.log('\n🗄️  Deleting MongoDB collections...');
  const existingCollections = (await db.listCollections().toArray()).map((c) => c.name);

  for (const col of COLLECTIONS_TO_DELETE) {
    if (existingCollections.includes(col)) {
      const result = await db.collection(col).deleteMany({});
      console.log(`   ✅ ${col}: Deleted ${result.deletedCount} documents`);
    } else {
      console.log(`   ⏭️  ${col}: Collection not found, skipping`);
    }
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log(' 🧹 EDUSYNC FULL CLEANUP SCRIPT');
  console.log('='.repeat(60));

  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  console.log('   ✅ Connected to:', db.databaseName);

  await deleteMongoData(db);
  await deleteCloudinaryAssets();

  await mongoose.disconnect();

  console.log('\n' + '='.repeat(60));
  console.log(' ✅ CLEANUP COMPLETE — All data has been deleted');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('\n💥 Script failed:', err.message);
  process.exit(1);
});
