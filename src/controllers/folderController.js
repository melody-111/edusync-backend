'use strict';

const Folder = require('../models/Folder');
const File = require('../models/File');
const mongoose = require('mongoose');
const { body, param } = require('express-validator');
const { asyncHandler, sendSuccess, sendError } = require('../utils/helpers');

/**
 * POST /folders
 * Creates a new folder for a student or teacher.
 */
const createFolder = asyncHandler(async (req, res) => {
  const { name, parentFolder, subject, folderType, color } = req.body;
  const user = req.user;

  try {
    const folder = await Folder.create({
      name,
      parentFolder: parentFolder || null,
      ownerId: user._id,
      ownerRole: user.role,
      subject: subject || 'General',
      folderType: folderType || 'notes',
      color: color || '#6c63ff',
    });

    return sendSuccess(res, { folder }, 'Folder created successfully', 201);
  } catch (error) {
    if (error.code === 11000) {
      return sendError(res, 'A folder with this name already exists in this location', 400);
    }
    throw error;
  }
});

/**
 * GET /folders
 * Lists all folders for the authenticated user (optionally filtered by subject or parentFolder).
 */
const getFolders = asyncHandler(async (req, res) => {
  const { subject, parentFolder } = req.query;
  const user = req.user;

  const query = {
    ownerId: user._id,
    isDeleted: false,
    parentFolder: parentFolder || null,
  };

  if (subject) query.subject = subject;

  const folders = await Folder.find(query).sort({ name: 1 }).lean();
  return sendSuccess(res, { folders, count: folders.length });
});

/**
 * GET /folders/:folderId
 * Lists all files within a specific folder.
 * Fix #1: Uses folderId field (now present on File model) instead of broken query.
 */
const getFolderContents = asyncHandler(async (req, res) => {
  const { folderId } = req.params;
  const user = req.user;

  const folder = await Folder.findOne({ _id: folderId, ownerId: user._id, isDeleted: false });
  if (!folder) return sendError(res, 'Folder not found', 404);

  const files = await File.find({ ownerId: user._id, folderId, isDeleted: false })
    .populate('sessionId', 'title startedAt status')
    .sort({ createdAt: -1 })
    .lean();

  return sendSuccess(res, { folder, files, count: files.length });
});

/**
 * PUT /folders/:folderId
 * Rename a folder, change its color, subject, or type.
 */
const updateFolder = asyncHandler(async (req, res) => {
  const { folderId } = req.params;
  const { name, color, subject, folderType } = req.body;
  const user = req.user;

  const updateFields = {};
  if (name !== undefined) updateFields.name = name.trim();
  if (color !== undefined) updateFields.color = color;
  if (subject !== undefined) updateFields.subject = subject;
  if (folderType !== undefined) updateFields.folderType = folderType;

  if (Object.keys(updateFields).length === 0) {
    return sendError(res, 'Nothing to update. Provide at least one field: name, color, subject, folderType.', 400);
  }

  const folder = await Folder.findOneAndUpdate(
    { _id: folderId, ownerId: user._id, isDeleted: false },
    updateFields,
    { new: true, runValidators: true }
  );

  if (!folder) return sendError(res, 'Folder not found or not yours', 404);

  return sendSuccess(res, { folder }, 'Folder updated successfully');
});

/**
 * DELETE /folders/:folderId
 * Soft-delete a folder and cascade soft-delete all files inside it.
 */
const deleteFolder = asyncHandler(async (req, res) => {
  const { folderId } = req.params;
  const user = req.user;

  const folder = await Folder.findOneAndUpdate(
    { _id: folderId, ownerId: user._id, isDeleted: false },
    { isDeleted: true, deletedAt: new Date() },
    { new: true }
  );

  if (!folder) return sendError(res, 'Folder not found or not yours', 404);

  // Cascade soft-delete: all files linked to this folder
  const { modifiedCount } = await File.updateMany(
    { ownerId: user._id, folderId, isDeleted: false },
    { isDeleted: true, deletedAt: new Date() }
  );

  return sendSuccess(res, { deletedFilesCount: modifiedCount }, 'Folder and its contents deleted');
});

/**
 * PATCH /folders/:folderId/files/:fileId
 * Move a file into a folder. Use folderId='none' to remove from folder (set to null).
 */
const moveFileToFolder = asyncHandler(async (req, res) => {
  const { folderId, fileId } = req.params;
  const user = req.user;

  // Validate target folder unless caller wants to detach (folderId === 'none')
  if (folderId !== 'none') {
    const folder = await Folder.findOne({ _id: folderId, ownerId: user._id, isDeleted: false });
    if (!folder) return sendError(res, 'Target folder not found or not yours', 404);
  }

  const file = await File.findOneAndUpdate(
    { _id: fileId, ownerId: user._id, isDeleted: false },
    { folderId: folderId === 'none' ? null : folderId },
    { new: true }
  );

  if (!file) return sendError(res, 'File not found or not yours', 404);

  return sendSuccess(
    res,
    { file },
    folderId === 'none' ? 'File removed from folder' : 'File moved to folder'
  );
});

const createFolderValidation = [
  body('name').notEmpty().trim().isLength({ min: 1, max: 50 }).withMessage('Folder name must be between 1-50 characters'),
  body('subject').optional().trim().isLength({ max: 30 }).withMessage('Subject name is too long'),
  body('folderType').optional().isIn(['notes', 'assignments', 'exams', 'resources']).withMessage('Invalid folder type'),
  body('color').optional().matches(/^#[0-9A-F]{6}$/i).withMessage('Invalid color format (hex required)'),
];

const updateFolderValidation = [
  body('name').optional().trim().isLength({ min: 1, max: 50 }).withMessage('Folder name must be between 1-50 characters'),
  body('subject').optional().trim().isLength({ max: 30 }).withMessage('Subject name is too long'),
  body('folderType').optional().isIn(['notes', 'assignments', 'exams', 'resources']).withMessage('Invalid folder type'),
  body('color').optional().matches(/^#[0-9A-F]{6}$/i).withMessage('Invalid color format (hex required)'),
];

const moveFileValidation = [
  param('folderId').notEmpty().withMessage('Target folder ID is required (or "none")'),
  param('fileId').isMongoId().withMessage('Invalid file ID'),
];

module.exports = {
  createFolder,
  getFolders,
  getFolderContents,
  updateFolder,
  deleteFolder,
  moveFileToFolder,
  createFolderValidation,
  updateFolderValidation,
  moveFileValidation,
};
