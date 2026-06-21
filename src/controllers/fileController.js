'use strict';

const File = require('../models/File');
const Page = require('../models/Page');
const StrokeBatch = require('../models/StrokeBatch');
const Session = require('../models/Session');
const User = require('../models/User');
const { compressStrokes, decompressStrokes } = require('../utils/compression');
const { asyncHandler, sendSuccess, sendError, paginate } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');
const { uploadCanvasData, deleteFromCloud, isCloudEnabled } = require('../services/cloudStorage');

// ─── Upload File ───────────────────────────────────────────────────────────────
const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) return sendError(res, 'No file provided', 400);

  const { sessionId, fileType, title, isBroadcast } = req.body;
  const user = req.user;

  // Teachers can broadcast; students cannot
  if (isBroadcast === 'true' && user.role !== 'teacher') {
    return sendError(res, 'Only teachers can broadcast files', 403);
  }

  // Validate session if provided
  let sessionDoc = null;
  if (sessionId) {
    sessionDoc = await Session.findOne({ $or: [{ _id: sessionId }, { sessionId }] });
    if (!sessionDoc) return sendError(res, 'Session not found', 404);
  }

  const file = await File.create({
    college_id: user.college_id,
    sessionId: sessionDoc?._id || null,
    ownerId: user._id,
    ownerRole: user.role,
    fileType: fileType || 'notes',
    title: title || req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
    storageKey: req.file.filename,
    url: `/uploads/files/${req.file.filename}`,
    isBroadcast: isBroadcast === 'true',
  });

  // Update user storage
  await User.findByIdAndUpdate(user._id, { $inc: { cloudStorageUsed: req.file.size || 0 } }).catch(() => {});

  logActivity({
    sessionId: sessionDoc?._id,
    userId: user._id,
    actorRole: user.role,
    action: 'file.upload',
    category: 'file',
    details: { fileId: file._id, fileType: file.fileType, size: file.size },
  });

  return sendSuccess(res, { file }, 'File uploaded', 201);
});

// ─── Get File ─────────────────────────────────────────────────────────────────
const getFile = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = req.user;

  const file = await File.findById(id).lean();
  if (!file || file.isDeleted) return sendError(res, 'File not found', 404);

  // Access check: own file OR broadcast file
  if (!file.isBroadcast && file.ownerId.toString() !== user._id.toString()) {
    return sendError(res, 'Access denied', 403);
  }

  return sendSuccess(res, { file });
});

// ─── Get User Notes (Mobile) ───────────────────────────────────────────────────
const getUserNotes = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, sessionId, fileType } = req.query;
  const user = req.user;

  const query = { ownerId: user._id, isDeleted: false };
  const sid = sessionId || req.params.sessionId;
  if (sid) query.sessionId = sid;
  if (fileType) query.fileType = fileType;

  const { docs: files, pagination } = await paginate(File, query, {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    sort: { createdAt: -1 },
    populate: { path: 'sessionId', select: 'title status startedAt endedAt' },
  });

  return sendSuccess(res, { files, pagination });
});

// ─── Delete File (Soft) ────────────────────────────────────────────────────────
const deleteFile = asyncHandler(async (req, res) => {
  const fileId = req.params.id || req.params.noteId;
  const file = await File.findOne({ _id: fileId, ownerId: req.user._id });
  if (!file) return sendError(res, 'File not found', 404);

  // Delete from Cloudinary if cloud-stored
  if (file.cloudPublicId) {
    const resourceType = file.cloudUrl && file.cloudUrl.includes('/image/') ? 'image' : 'raw';
    deleteFromCloud(file.cloudPublicId, resourceType).catch(() => {});
  }

  file.isDeleted = true;
  file.deletedAt = new Date();
  await file.save();

  // Free up storage
  await User.findByIdAndUpdate(req.user._id, { $inc: { cloudStorageUsed: -(file.size || 0) } }).catch(() => {});

  // Log activity
  logActivity({
    userId: req.user._id,
    actorRole: req.user.role,
    action: 'file.delete',
    category: 'file',
    details: { fileId: file._id, title: file.title },
  });

  return sendSuccess(res, null, 'File deleted');
});

// ─── Save Stroke Batch ─────────────────────────────────────────────────────────
const saveStrokeBatch = asyncHandler(async (req, res) => {
  const { sessionId, pageId, strokes, batchIndex } = req.body;
  const user = req.user;

  if (!Array.isArray(strokes) || strokes.length === 0) {
    return sendError(res, 'strokes array required', 400);
  }

  // Verify page belongs to user
  const page = await Page.findById(pageId);
  if (!page) return sendError(res, 'Page not found', 404);
  if (page.ownerId.toString() !== user._id.toString()) return sendError(res, 'Access denied', 403);

  // Compress strokes
  const compressed = await compressStrokes(strokes);

  await StrokeBatch.create({
    sessionId,
    pageId,
    ownerId: user._id,
    ownerRole: user.role,
    strokesData: compressed,
    strokeCount: strokes.length,
    batchIndex: batchIndex || 0,
    compressed: true,
  });

  return sendSuccess(res, { strokeCount: strokes.length }, 'Stroke batch saved');
});

// ─── Get Strokes for Page ─────────────────────────────────────────────────────
const getPageStrokes = asyncHandler(async (req, res) => {
  const { pageId } = req.params;
  const user = req.user;

  const page = await Page.findById(pageId);
  if (!page) return sendError(res, 'Page not found', 404);

  // Students can only get own strokes; teachers can get all
  const query = { pageId };
  if (user.role === 'student') query.ownerId = user._id;

  const batches = await StrokeBatch.find(query).sort({ batchIndex: 1, createdAt: 1 });

  // Decompress all batches
  const allStrokes = [];
  for (const batch of batches) {
    const strokes = await decompressStrokes(batch.strokesData);
    allStrokes.push(...strokes);
  }

  return sendSuccess(res, { strokes: allStrokes, pageId });
});

// ─── Manage Pages ─────────────────────────────────────────────────────────────
const createPage = asyncHandler(async (req, res) => {
  const { sessionId, pageNumber, backgroundType, backgroundUrl, fileId } = req.body;
  const user = req.user;

  const session = await Session.findOne({ $or: [{ _id: sessionId }, { sessionId }] });
  if (!session) return sendError(res, 'Session not found', 404);

  const page = await Page.create({
    sessionId: session._id,
    fileId: fileId || null,
    ownerId: user._id,
    ownerRole: user.role,
    pageNumber,
    backgroundType: backgroundType || 'blank',
    backgroundUrl: backgroundUrl || null,
  });

  return sendSuccess(res, { page }, 'Page created', 201);
});

const getSessionPages = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const user = req.user;

  const session = await Session.findOne({ $or: [{ _id: sessionId }, { sessionId }] });
  if (!session) return sendError(res, 'Session not found', 404);

  const query = { sessionId: session._id, isDeleted: false };
  if (user.role === 'student') query.ownerId = user._id;

  const pages = await Page.find(query).sort({ pageNumber: 1 }).lean();
  return sendSuccess(res, { pages });
});

// ─── Save Note (Canvas Persistence) ─────────────────────────────────────────
const saveNote = asyncHandler(async (req, res) => {
  const { title, canvasData, fileType, folderId, id, isBroadcast } = req.body;
  const user = req.user;

  // ── UPDATE existing note ────────────────────────────────────────────────
  if (id && id.match(/^[0-9a-fA-F]{24}$/)) {
    const existingFile = await File.findOne({ _id: id, ownerId: user._id });
      if (existingFile) {
      const updateData = { title, updatedAt: new Date() };
      
      if (isBroadcast !== undefined) {
        updateData.isBroadcast = isBroadcast === true || isBroadcast === 'true';
        if (req.body.targetClassroom !== undefined) updateData.targetClassroom = req.body.targetClassroom;
        if (req.body.targetSemester !== undefined) updateData.targetSemester = req.body.targetSemester;
        if (req.body.targetBranch !== undefined) updateData.targetBranch = req.body.targetBranch;
      }

      // Try cloud upload if enabled
      if (canvasData !== undefined) {
        if (canvasData && isCloudEnabled()) {
          // Delete old cloud file if exists
          if (existingFile.cloudPublicId) {
            const oldResourceType = existingFile.cloudUrl && existingFile.cloudUrl.includes('/image/') ? 'image' : 'raw';
            deleteFromCloud(existingFile.cloudPublicId, oldResourceType).catch(() => {});
          }

          const cloudResult = await uploadCanvasData(canvasData, user._id.toString(), id);
          if (cloudResult) {
            updateData.cloudUrl = cloudResult.cloudUrl;
            updateData.cloudPublicId = cloudResult.cloudPublicId;
            updateData.canvasData = null; // Don't store in MongoDB when cloud is used
          } else {
            // Fallback: store in MongoDB
            updateData.canvasData = canvasData;
          }
        } else {
          updateData.canvasData = canvasData;
        }
      }

      const file = await File.findOneAndUpdate(
        { _id: id, ownerId: user._id },
        updateData,
        { new: true }
      );
      return sendSuccess(res, { file }, 'Note updated');
    }
  }

  // ── CREATE new note ─────────────────────────────────────────────────────
  const createData = {
    college_id: user.college_id,
    ownerId: user._id,
    ownerRole: user.role,
    fileType: fileType || 'notes',
    title: title || 'Untitled Note',
    folderId: folderId || null,
    isBroadcast: isBroadcast === true || isBroadcast === 'true',
  };

  // Try cloud upload if enabled
  if (canvasData && isCloudEnabled()) {
    // Use a temp ID for naming; will update after creation
    const tempId = Date.now().toString(36);
    const cloudResult = await uploadCanvasData(canvasData, user._id.toString(), tempId);
    if (cloudResult) {
      createData.cloudUrl = cloudResult.cloudUrl;
      createData.cloudPublicId = cloudResult.cloudPublicId;
      createData.canvasData = null;
    } else {
      // Fallback: store in MongoDB
      createData.canvasData = canvasData;
    }
  } else {
    createData.canvasData = canvasData;
  }

  const file = await File.create(createData);

  return sendSuccess(res, { file }, 'Note saved', 201);
});

const generatePdfFromNote = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = req.user;

  const file = await File.findById(id).lean();
  if (!file || file.isDeleted) return sendError(res, 'Note not found', 404);
  if (!file.isBroadcast && file.ownerId.toString() !== user._id.toString()) {
    return sendError(res, 'Access denied', 403);
  }

  try {
    const pdfGenerator = require('../utils/pdfGenerator');
    // For standalone notes, the 'canvasData' field contains the base64 image or json
    // Our pdfGenerator can use 'canvasData' (if it's base64 png).
    // Note: The teacher/student app will now send 'canvasData' as base64 or have an 'imageData' field.
    // Let's pass the whole file object as noteData
    const pdfBuffer = await pdfGenerator.generatePDF({
      id: file._id.toString(),
      title: file.title,
      content: file.content || '',
      canvasData: file.canvasData, // Should be base64 PNG for this to work
      updatedAt: file.updatedAt
    });

    logActivity({
      userId: user._id,
      actorRole: user.role,
      action: 'pdf.export',
      category: 'file',
      details: { fileId: file._id, title: file.title },
    });

    pdfGenerator.streamPDF(pdfBuffer, res, `${file.title || 'Note'}.pdf`);
  } catch (err) {
    console.error('PDF Generation Error:', err);
    return sendError(res, 'Failed to generate PDF', 500);
  }
});

module.exports = {
  uploadFile,
  getFile,
  getUserNotes,
  deleteFile,
  deleteNote: deleteFile,
  saveStrokeBatch,
  getPageStrokes,
  createPage,
  getSessionPages,
  saveNote,
  generatePdfFromNote,
};

// Fetch all broadcast files created by teachers
const getSharedFiles = asyncHandler(async (req, res) => {
  const { college_id, institutionType, classroomId, semester, branch } = req.user;

  const baseQuery = {
    college_id,
    ownerRole: 'teacher',
    isBroadcast: true,
    isDeleted: false,
  };

  const targetConditions = [
    { targetClassroom: null, targetSemester: null, targetBranch: null } // Global
  ];

  if (institutionType === 'school') {
    if (classroomId) targetConditions.push({ targetClassroom: classroomId });
  } else if (institutionType === 'university') {
    if (semester) targetConditions.push({ targetSemester: semester });
    if (branch) targetConditions.push({ targetBranch: branch });
    if (semester && branch) targetConditions.push({ targetSemester: semester, targetBranch: branch });
  }

  const query = {
    ...baseQuery,
    $or: targetConditions,
  };

  // Find all files that are broadcasted by teachers in the same college and match targets
  const files = await File.find(query)
    .populate('folderId', 'name color subject folderType')
    .sort({ createdAt: -1 });

  return sendSuccess(res, 'Shared files fetched', { files });
});

module.exports.getSharedFiles = getSharedFiles;
