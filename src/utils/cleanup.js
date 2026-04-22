'use strict';

const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

/**
 * Deletes files older than specified days in a directory
 * @param {string} dirPath 
 * @param {number} days 
 */
const cleanupOldFiles = async (dirPath, days = 7) => {
  try {
    const exists = await fs.pathExists(dirPath);
    if (!exists) return;

    const files = await fs.readdir(dirPath);
    const now = Date.now();
    const threshold = days * 24 * 60 * 60 * 1000;

    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      // Skip hidden files
      if (file.startsWith('.')) continue;

      const stats = await fs.stat(filePath);
      
      // If it's a directory, recurse (only for exports)
      if (stats.isDirectory() && file !== 'pdfs') {
        await cleanupOldFiles(filePath, days);
        continue;
      }

      if (now - stats.mtimeMs > threshold) {
        await fs.remove(filePath);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logger.info(`[Cleanup] Deleted ${deletedCount} files older than ${days} days in ${dirPath}`);
    }
  } catch (err) {
    logger.error(`[Cleanup] Error cleaning ${dirPath}: ${err.message}`);
  }
};

module.exports = { cleanupOldFiles };
