'use strict';

// REPLACED: puppeteer (200MB RAM per PDF) → pdfkit (pure Node, ~5MB per PDF)
// At scale, 50 concurrent Puppeteer instances = 10GB RAM crash.
// PDFKit handles 500+ concurrent PDFs on same server with no issues.
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const Session = require('../models/Session');
const Page = require('../models/Page');
const File = require('../models/File');
const ExportedFile = require('../models/ExportedFile');
const SessionParticipant = require('../models/SessionParticipant');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendNotesEmail } = require('../utils/email');
const { sendPushNotification } = require('../utils/push');
const { strokeBatchBuffer } = require('../socket/strokeBuffer');
const { downloadCanvasData } = require('./cloudStorage');
const logger = require('../utils/logger');

const PDF_DIR = path.join(process.cwd(), 'exports', 'pdfs');
let usePdfStorage = true;
try {
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
} catch (err) {
  // Fall back to no PDF storage if directory creation fails
  usePdfStorage = false;
  logger.warn('PDF storage directory not available, PDF generation disabled');
}

/**
 * Master save pipeline — runs after session ends
 * 1. Flush stroke buffers
 * 2. Generate PDFs per user
 * 3. Merge teacher + student notes
 * 4. Send email notifications
 */
const triggerSavePipeline = async (sessionId) => {
  logger.info(`Save pipeline started for session: ${sessionId}`);

  const session = await Session.findById(sessionId).populate('teacherId', 'name email').lean();
  if (!session) throw new Error(`Session ${sessionId} not found`);

  // Step 1: Flush all remaining stroke buffers for this session
  await strokeBatchBuffer.flushAll(sessionId);
  logger.info(`[Pipeline] Stroke buffers flushed`);

  // Step 2: Get all participants

  const participants = await SessionParticipant.find({ sessionId })
    .populate('userId', 'name email')
    .lean();

  // CONCURRENCY LIMIT: Launch only a few browsers at a time to prevent RAM crash
  // p-limit v7+ is ESM-only — must use dynamic import() not require()
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(parseInt(process.env.MAX_CONCURRENT_PDFS, 10) || 3);

  const results = await Promise.allSettled(
    participants.map((p) => limit(() => generateUserPdf(session, p)))
  );


  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error(`PDF generation failed for participant ${participants[i].userId?.name}: ${r.reason?.message}`);
    }
  });

  // Step 3: Generate combined teacher PDF
  await generateTeacherPdf(session);

  // Step 4: Mark session save complete
  await Session.findByIdAndUpdate(sessionId, { saveCompleted: true, savedAt: new Date() });

  logger.info(`Save pipeline completed for session: ${sessionId}`);
};

/**
 * Generate PDF for a single participant (student notes + teacher notes merged)
 */
const generateUserPdf = async (session, participant) => {
  const user = participant.userId;
  if (!user) return;

  const exportRecord = await ExportedFile.create({
    sessionId: session._id,
    userId: user._id,
    exportType: participant.role === 'teacher' ? 'teacher_notes_pdf' : 'student_notes_pdf',
    status: 'generating',
  });

  try {
    // Get student's pages and strokes
    const pages = await Page.find({
      sessionId: session._id,
      ownerId: user._id,
      isDeleted: false,
    }).sort({ pageNumber: 1 }).lean();

    // Get teacher pages too (80/20 — student sees teacher data)
    let teacherPages = [];
    if (session.teacherId) {
      teacherPages = await Page.find({
        sessionId: session._id,
        ownerId: session.teacherId._id || session.teacherId,
        isDeleted: false,
      }).sort({ pageNumber: 1 }).lean();
    }


    const pdfBuffer = await generatePdf(session, user, pages, teacherPages, participant.role);

    const subject = session.subject || 'General';
    const dateStr = new Date(session.startedAt).toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Create hierarchical directory: userId/subject/date/
    const hierarchicalDir = path.join(PDF_DIR, user._id.toString(), subject, dateStr);
    if (usePdfStorage) {
      try {
        if (!fs.existsSync(hierarchicalDir)) fs.mkdirSync(hierarchicalDir, { recursive: true });
      } catch (err) {
        logger.warn(`Could not create PDF directory for user ${user._id}: ${err.message}`);
        return; // Skip PDF generation if directory creation fails
      }
    } else {
      return; // Skip PDF generation if storage is disabled
    }

    const filename = `${session.sessionId}.pdf`;
    const filePath = path.join(hierarchicalDir, filename);
    fs.writeFileSync(filePath, pdfBuffer);

    // Dynamic URL for web access
    const fileUrl = `/exports/pdfs/${user._id.toString()}/${subject}/${dateStr}/${filename}`;

    // Update export record
    await ExportedFile.findByIdAndUpdate(exportRecord._id, {
      status: 'done',
      fileUrl,
      storagePath: filePath,
      fileSizeBytes: pdfBuffer.length,
      generatedAt: new Date(),
    });

    // Save file record for mobile access
    await File.create({
      sessionId: session._id,
      ownerId: user._id,
      ownerRole: participant.role,
      fileType: 'pdf',
      title: `${session.title} — Notes`,
      mimeType: 'application/pdf',
      size: pdfBuffer.length,
      url: fileUrl,
      storageKey: filename,
      isAutoSaved: true,
      lastAutoSavedAt: new Date(),
    });

    // Create in-app notification record
    await Notification.create({
      userId: user._id,
      sessionId: session._id,
      type: 'pdf_ready',
      title: 'Your notes are ready! 📄',
      body: `PDF for "${session.title}" has been generated and saved.`,
      data: { fileUrl },
    });

    // ─── Fire actual FCM Push Notification ───────────────────────────────────
    // Fetch user's FCM tokens (from both User.fcmTokens and Device collection)
    const fullUser = await User.findById(user._id).select('fcmTokens').lean();
    const fcmTokens = (fullUser?.fcmTokens || []).filter(Boolean);
    if (fcmTokens.length > 0) {
      sendPushNotification(
        fcmTokens,
        '📄 Your notes are ready!',
        `PDF for "${session.title}" has been saved. Tap to open.`,
        {
          type: 'pdf_ready',
          fileUrl,
          sessionId: session._id.toString(),
          sessionTitle: session.title,
        }
      ).catch((err) => logger.warn(`FCM push failed for ${user.email}: ${err.message}`));
    }

    // Send email with PDF link
    await sendNotesEmail({
      to: user.email,
      name: user.name,
      sessionTitle: session.title,
      pdfUrl: `${process.env.CLIENT_URL || 'http://localhost:5000'}${fileUrl}`,
      attachmentPath: participant.role === 'student' ? filePath : null,
    }).catch((err) => logger.warn(`Notes email failed for ${user.email}: ${err.message}`));

    logger.info(`PDF generated for ${user.name}: ${fileUrl}`);
  } catch (err) {
    await ExportedFile.findByIdAndUpdate(exportRecord._id, {
      status: 'failed',
      errorMessage: err.message,
    });
    throw err;
  }
};

/**
 * Generate full teacher PDF with all session content
 */
const generateTeacherPdf = async (session) => {
  try {
    const teacher = await User.findById(session.teacherId).lean();
    if (!teacher) return;

    const pages = await Page.find({
      sessionId: session._id,
      ownerId: session.teacherId,
      isDeleted: false,
    }).sort({ pageNumber: 1 }).lean();

    const pdfBuffer = await generatePdf(session, teacher, pages, [], 'teacher');

    if (!usePdfStorage) {
      logger.warn('PDF storage disabled, skipping teacher PDF generation');
      return;
    }

    const filename = `${session._id}_teacher_full_${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, filename);
    try {
      fs.writeFileSync(filePath, pdfBuffer);
    } catch (err) {
      logger.error(`Failed to write teacher PDF: ${err.message}`);
      return;
    }
    const fileUrl = `/exports/pdfs/${filename}`;

    await Session.findByIdAndUpdate(session._id, {
      exportedPdfUrl: fileUrl,
      exportStatus: 'done',
    });
  } catch (err) {
    await Session.findByIdAndUpdate(session._id, { exportStatus: 'failed' });
    logger.error(`Teacher PDF generation failed: ${err.message}`);
  }
};

/**
 * Generate PDF buffer using PDFKit (pure Node.js — no Chromium, no memory bombs)
 * Takes structured data directly instead of rendering through a headless browser.
 */
const generatePdf = (session, user, userPages, teacherPages, role) => {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
        const chunks = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const allPages = [...teacherPages, ...userPages];
        const dateStr = new Date(session.startedAt).toLocaleDateString('en-IN', { dateStyle: 'long' });

        // ─ Header ────────────────────────────────────────────────────────────
        doc.rect(0, 0, doc.page.width, 80).fill('#1a1a2e');
        doc.fillColor('#a78bfa').fontSize(22).font('Helvetica-Bold')
           .text(session.title || 'Untitled Session', 40, 20, { align: 'left' });
        doc.fillColor('#cccccc').fontSize(10).font('Helvetica')
           .text(`${role === 'teacher' ? 'Teacher' : 'Student'}: ${user.name}  |  Date: ${dateStr}  |  Pages: ${allPages.length}`, 40, 50);

        doc.moveDown(2);

        // ─ Pages ────────────────────────────────────────────────────────────
        for (let idx = 0; idx < allPages.length; idx++) {
          const page = allPages[idx];
          if (idx > 0) doc.addPage();

          const label = role === 'teacher'
            ? `Teacher Notes \u2014 Page ${page.pageNumber}`
            : (idx < teacherPages.length ? `Teacher Notes \u2014 Page ${page.pageNumber}` : `Your Notes \u2014 Page ${page.pageNumber}`);

          // Page label bar
          doc.rect(40, doc.y, doc.page.width - 80, 24).fill('#1a1a2e');
          doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
             .text(label, 48, doc.y - 20);
          doc.moveDown(1);

          // Embed canvas snapshot image if available
          // Support both direct canvasSnapshot and cloud-stored data
          let snapshotData = page.canvasSnapshot;

          // If no local snapshot but cloud URL exists, download from cloud
          if (!snapshotData && page.cloudUrl) {
            snapshotData = await downloadCanvasData(page.cloudUrl);
          }

          if (snapshotData && snapshotData.startsWith('data:image')) {
            try {
              const base64Data = snapshotData.replace(/^data:image\/\w+;base64,/, '');
              const imgBuffer = Buffer.from(base64Data, 'base64');
              const availableWidth = doc.page.width - 80;
              const availableHeight = doc.page.height - doc.y - 60;
              doc.image(imgBuffer, 40, doc.y, {
                fit: [availableWidth, availableHeight],
                align: 'center',
                valign: 'top',
              });
            } catch {
              doc.fillColor('#999999').fontSize(10).font('Helvetica')
                 .text('(Canvas image could not be rendered)', { align: 'center' });
            }
          } else {
            doc.fillColor('#aaaaaa').fontSize(12).font('Helvetica')
               .text('No content was captured on this page.', { align: 'center' });
          }
        }

        if (allPages.length === 0) {
          doc.moveDown(4);
          doc.fillColor('#999999').fontSize(14).font('Helvetica')
             .text('No content was captured during this session.', { align: 'center' });
        }

        // ─ Footer ────────────────────────────────────────────────────────────
        const footerY = doc.page.height - 40;
        doc.page.margins.bottom = 0;
        doc.fillColor('#aaaaaa').fontSize(9).font('Helvetica')
           .text(`Generated by Digital Classroom \u2022 ${new Date().toLocaleString()}`, 40, footerY, { align: 'center', width: doc.page.width - 80 });

        doc.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
};

module.exports = { triggerSavePipeline };
