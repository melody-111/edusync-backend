'use strict';

const File = require('../models/File');
const Page = require('../models/Page');
const StrokeBatch = require('../models/StrokeBatch');
const Session = require('../models/Session');
const { compressStrokes, decompressStrokes } = require('../utils/compression');
const { asyncHandler, sendSuccess, sendError, paginate } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');

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

  file.isDeleted = true;
  file.deletedAt = new Date();
  await file.save();

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
  const { title, canvasData, fileType, folderId, id } = req.body;
  const user = req.user;

  if (id && id.match(/^[0-9a-fA-F]{24}$/)) {
    const file = await File.findOneAndUpdate(
      { _id: id, ownerId: user._id },
      { title, canvasData, updatedAt: new Date() },
      { new: true }
    );
    if (file) return sendSuccess(res, { file }, 'Note updated');
  }

  const file = await File.create({
    college_id: user.college_id,
    ownerId: user._id,
    ownerRole: user.role,
    fileType: fileType || 'notes',
    title: title || 'Untitled Note',
    canvasData,
    folderId: folderId || null
  });

  return sendSuccess(res, { file }, 'Note saved', 201);
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
  saveSnapshot,
  saveNote,
};
