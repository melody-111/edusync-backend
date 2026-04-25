const { Worker } = require('bullmq');
const PDFDocument = require('pdfkit');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const File = require('../models/File');

/**
 * PDF Generation Worker
 * Processes 'generate-pdf' jobs from the queue
 */
const pdfWorker = new Worker('pdf-generation', async (job) => {
  const { sessionId, title } = job.data;
  logger.info(`Starting PDF generation for job: ${job.id} (Session: ${sessionId})`);

  try {
    const exportPath = path.join(__dirname, '../../exports', `${sessionId}-notes.pdf`);
    await fs.ensureDir(path.dirname(exportPath));

    const doc = new PDFDocument();
    const stream = fs.createWriteStream(exportPath);
    doc.pipe(stream);

    doc.fontSize(25).text(title || 'Class Notes Recovery', 100, 100);
    doc.fontSize(12).text(`Session ID: ${sessionId}`, 100, 150);
    doc.fontSize(12).text(`Generated at: ${new Date().toLocaleString()}`, 100, 170);

    // TODO: Use canvasData to render Fabric.js objects into PDF (requires custom logic or puppeteer)
    // For now, we'll watermark the file as 'Rendered by Worker'
    doc.addPage().fontSize(40).text('CANVAS DATA SAVED (Background Sync)', 100, 100);

    doc.end();

    // Wait for the stream to finish
    await new Promise((resolve) => stream.on('finish', resolve));

    // Update the original File record with the export URL
    await File.findOneAndUpdate(
       { sessionId }, 
       { pdfUrl: `/exports/${sessionId}-notes.pdf` }
    );

    logger.info(`Successfully generated PDF for session ${sessionId}`);
    return { path: exportPath };
  } catch (err) {
    logger.error(`PDF Worker Error (Job: ${job.id}): ${err.message}`);
    throw err; // trigger BullMQ retry
  }
}, {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  },
  concurrency: 5, // Process 5 PDFs concurrently per worker node
});

pdfWorker.on('completed', (job) => logger.debug(`Job ${job.id} completed`));
pdfWorker.on('failed', (job, err) => logger.error(`Job ${job.id} failed: ${err.message}`));

module.exports = pdfWorker;
