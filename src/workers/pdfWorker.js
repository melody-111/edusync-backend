'use strict';

const { Worker } = require('bullmq');
const PDFDocument = require('pdfkit');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const File = require('../models/File');
const { createRedisClient } = require('../config/redis');

let pdfWorker = null;
const connection = createRedisClient();

if (connection) {
  pdfWorker = new Worker('pdf-generation', async (job) => {
    const { sessionId, title, canvasData, pages } = job.data;
    logger.info(`Starting PDF generation for job: ${job.id} (Session: ${sessionId})`);

    try {
      const exportPath = path.join(__dirname, '../../exports', `${sessionId}-notes.pdf`);
      await fs.ensureDir(path.dirname(exportPath));

      const doc = new PDFDocument({ autoFirstPage: false });
      const stream = fs.createWriteStream(exportPath);
      doc.pipe(stream);

      // Process canvas data if provided
      const pageData = pages || canvasData || [];
      
      if (Array.isArray(pageData) && pageData.length > 0) {
        for (let i = 0; i < pageData.length; i++) {
          const page = pageData[i];
          
          doc.addPage();
          doc.fontSize(16).text(title || 'Class Notes', 50, 30, { width: 500, align: 'center' });
          doc.fontSize(10).text(`Page ${i + 1} of ${pageData.length}`, 50, 50);
          doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, 50, 65);
          
          if (typeof page === 'string' && page.startsWith('data:image')) {
            try {
              const base64Data = page.replace(/^data:image\/\w+;base64,/, '');
              const buffer = Buffer.from(base64Data, 'base64');
              
              const pageWidth = doc.page.width;
              const pageHeight = doc.page.height;
              const margin = 50;
              const maxWidth = pageWidth - (margin * 2);
              const maxHeight = pageHeight - 120;
              
              doc.image(buffer, margin, 80, {
                fit: [maxWidth, maxHeight],
                align: 'center',
                valign: 'center'
              });
            } catch (imgErr) {
              logger.error(`Failed to embed image on page ${i + 1}: ${imgErr.message}`);
              doc.fontSize(12).text('[Image rendering failed]', 50, 100);
            }
          } else if (typeof page === 'object' && page.objects) {
            doc.fontSize(12).text('[Fabric.js canvas data - requires canvas rendering]', 50, 100);
            doc.fontSize(10).text(`Objects count: ${page.objects?.length || 0}`, 50, 120);
          } else {
            doc.fontSize(12).text('[Empty page]', 50, 100);
          }
        }
      } else {
        doc.addPage();
        doc.fontSize(25).text(title || 'Class Notes Recovery', 100, 100);
        doc.fontSize(12).text(`Session ID: ${sessionId}`, 100, 150);
        doc.fontSize(12).text(`Generated at: ${new Date().toLocaleString()}`, 100, 170);
        doc.fontSize(12).text('No canvas data provided for rendering.', 100, 200);
      }

      doc.end();
      await new Promise((resolve) => stream.on('finish', resolve));

      await File.findOneAndUpdate(
         { sessionId }, 
         { pdfUrl: `/exports/${sessionId}-notes.pdf` }
      );

      logger.info(`Successfully generated PDF for session ${sessionId} with ${pageData.length} pages`);
      return { path: exportPath, pages: pageData.length };
    } catch (err) {
      logger.error(`PDF Worker Error (Job: ${job.id}): ${err.message}`);
      throw err;
    }
  }, {
    connection,
    concurrency: 5,
  });

  pdfWorker.on('completed', (job) => logger.debug(`Job ${job.id} completed`));
  pdfWorker.on('failed', (job, err) => logger.error(`Job ${job.id} failed: ${err.message}`));
  pdfWorker.on('error', (err) => logger.warn(`[PDF Worker] Redis notice: ${err.message}`));
} else {
  logger.info('[PDF Worker] Redis connection not configured — background worker inactive.');
}

module.exports = pdfWorker;
