const { Worker } = require('bullmq');
const PDFDocument = require('pdfkit');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const File = require('../models/File');

/**
 * PDF Generation Worker
 * Processes 'generate-pdf' jobs from the queue
 * Renders canvas data (base64 images or Fabric.js JSON) into PDF
 */
const pdfWorker = new Worker('pdf-generation', async (job) => {
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
        
        // Add a new page for each canvas page
        doc.addPage();
        
        // Add header for each page
        doc.fontSize(16).text(title || 'Class Notes', 50, 30, { width: 500, align: 'center' });
        doc.fontSize(10).text(`Page ${i + 1} of ${pageData.length}`, 50, 50);
        doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, 50, 65);
        
        // Check if page contains base64 image data
        if (typeof page === 'string' && page.startsWith('data:image')) {
          try {
            const base64Data = page.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            
            // Calculate image dimensions to fit page
            const pageWidth = doc.page.width;
            const pageHeight = doc.page.height;
            const margin = 50;
            const maxWidth = pageWidth - (margin * 2);
            const maxHeight = pageHeight - 120; // Leave space for header
            
            doc.image(buffer, margin, 80, {
              fit: [maxWidth, maxHeight],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            logger.error(`Failed to embed image on page ${i + 1}: ${imgErr.message}`);
            doc.fontSize(12).text('[Image rendering failed]', 50, 100);
          }
        } 
        // Check if page is Fabric.js JSON object
        else if (typeof page === 'object' && page.objects) {
          // Fabric.js JSON - would require canvas rendering
          // For now, add a placeholder indicating this needs canvas rendering
          doc.fontSize(12).text('[Fabric.js canvas data - requires canvas rendering]', 50, 100);
          doc.fontSize(10).text(`Objects count: ${page.objects?.length || 0}`, 50, 120);
        }
        // Fallback for empty or invalid data
        else {
          doc.fontSize(12).text('[Empty page]', 50, 100);
        }
      }
    } else {
      // No canvas data provided - create a simple PDF with metadata
      doc.addPage();
      doc.fontSize(25).text(title || 'Class Notes Recovery', 100, 100);
      doc.fontSize(12).text(`Session ID: ${sessionId}`, 100, 150);
      doc.fontSize(12).text(`Generated at: ${new Date().toLocaleString()}`, 100, 170);
      doc.fontSize(12).text('No canvas data provided for rendering.', 100, 200);
    }

    doc.end();

    // Wait for the stream to finish
    await new Promise((resolve) => stream.on('finish', resolve));

    // Update the original File record with the export URL
    await File.findOneAndUpdate(
       { sessionId }, 
       { pdfUrl: `/exports/${sessionId}-notes.pdf` }
    );

    logger.info(`Successfully generated PDF for session ${sessionId} with ${pageData.length} pages`);
    return { path: exportPath, pages: pageData.length };
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
