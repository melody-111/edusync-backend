'use strict';

const PDFDocument = require('pdf-lib');
const { Readable } = require('stream');
const { cache } = require('../config/redis');
const logger = require('./logger');

/**
 * Optimized PDF generation for high traffic
 * Uses caching, streaming, and async processing to prevent crashes
 */
class PDFGenerator {
  constructor() {
    this.cachePrefix = 'pdf:';
    this.cacheTTL = 3600; // 1 hour
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  /**
   * Generate PDF with caching and retry logic
   */
  async generatePDF(noteData, options = {}) {
    const cacheKey = this.generateCacheKey(noteData);
    
    try {
      // Check cache first
      const cached = await this.getCachedPDF(cacheKey);
      if (cached) {
        logger.info('PDF served from cache');
        return cached;
      }

      // Generate PDF with retry logic
      const pdfBuffer = await this.generatePDFWithRetry(noteData, options);
      
      // Cache the result
      await this.cachePDF(cacheKey, pdfBuffer);
      
      return pdfBuffer;
    } catch (error) {
      logger.error('PDF generation failed:', error);
      throw new Error('Failed to generate PDF');
    }
  }

  /**
   * Generate PDF with retry logic
   */
  async generatePDFWithRetry(noteData, options, retryCount = 0) {
    try {
      return await this.createPDF(noteData, options);
    } catch (error) {
      if (retryCount < this.maxRetries) {
        logger.warn(`PDF generation failed, retry ${retryCount + 1}/${this.maxRetries}`);
        await this.sleep(this.retryDelay * (retryCount + 1));
        return this.generatePDFWithRetry(noteData, options, retryCount + 1);
      }
      throw error;
    }
  }

  /**
   * Create PDF from note data
   */
  async createPDF(noteData, options = {}) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 size

    // Add content to PDF
    const { title, content, canvasData } = noteData;

    // Add title
    const titleText = title || 'Untitled Note';
    const titleFont = await pdfDoc.embedFont(PDFDocument.Fonts.HelveticaBold);
    const titleSize = 24;
    const titleWidth = titleFont.widthOfTextAtSize(titleText, titleSize);
    const titleX = (595.28 - titleWidth) / 2;
    page.drawText(titleText, {
      x: titleX,
      y: 800,
      size: titleSize,
      font: titleFont,
    });

    // Add content
    if (content) {
      const contentFont = await pdfDoc.embedFont(PDFDocument.Fonts.Helvetica);
      const contentSize = 12;
      const contentY = 750;
      
      // Split content into lines
      const lines = this.splitText(content, 80);
      let currentY = contentY;
      
      for (const line of lines) {
        if (currentY < 50) {
          // Add new page if needed
          pdfDoc.addPage([595.28, 841.89]);
          currentY = 800;
        }
        
        page.drawText(line, {
          x: 50,
          y: currentY,
          size: contentSize,
          font: contentFont,
        });
        currentY -= 20;
      }
    }

    // Add canvas data as image if available
    if (canvasData && options.includeCanvas !== false) {
      try {
        const image = await pdfDoc.embedPng(canvasData);
        const { width, height } = image.scale(0.5);
        page.drawImage(image, {
          x: 50,
          y: currentY - height - 50,
          width,
          height,
        });
      } catch (error) {
        logger.warn('Failed to embed canvas image:', error.message);
      }
    }

    // Add metadata
    pdfDoc.setTitle(titleText);
    pdfDoc.setAuthor('Digital Classroom');
    pdfDoc.setSubject('Class Notes');
    pdfDoc.setCreationDate(new Date());
    pdfDoc.setModificationDate(new Date());

    // Generate PDF buffer
    const pdfBytes = await pdfDoc.save();
    
    return Buffer.from(pdfBytes);
  }

  /**
   * Generate cache key from note data
   */
  generateCacheKey(noteData) {
    const { id, title, content, updatedAt } = noteData;
    const keyData = `${id}-${title}-${content}-${updatedAt}`;
    return `${this.cachePrefix}${crypto.createHash('md5').update(keyData).digest('hex')}`;
  }

  /**
   * Get cached PDF
   */
  async getCachedPDF(cacheKey) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return Buffer.from(cached, 'base64');
      }
      return null;
    } catch (error) {
      logger.error('Failed to get cached PDF:', error);
      return null;
    }
  }

  /**
   * Cache PDF
   */
  async cachePDF(cacheKey, pdfBuffer) {
    try {
      await cache.set(cacheKey, pdfBuffer.toString('base64'), this.cacheTTL);
    } catch (error) {
      logger.error('Failed to cache PDF:', error);
    }
  }

  /**
   * Invalidate cached PDF
   */
  async invalidateCache(noteData) {
    try {
      const cacheKey = this.generateCacheKey(noteData);
      await cache.del(cacheKey);
      logger.info('PDF cache invalidated');
    } catch (error) {
      logger.error('Failed to invalidate PDF cache:', error);
    }
  }

  /**
   * Split text into lines
   */
  splitText(text, maxChars) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).length <= maxChars) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stream PDF to response (for large PDFs)
   */
  streamPDF(pdfBuffer, res, filename = 'note.pdf') {
    const stream = new Readable();
    stream.push(pdfBuffer);
    stream.push(null);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    stream.pipe(res);
  }

  /**
   * Batch generate PDFs for multiple notes
   */
  async generateBatchPDFs(notes, options = {}) {
    const results = [];
    const batchSize = options.batchSize || 10;
    
    for (let i = 0; i < notes.length; i += batchSize) {
      const batch = notes.slice(i, i + batchSize);
      const batchPromises = batch.map(note => 
        this.generatePDF(note, options).catch(error => {
          logger.error(`Failed to generate PDF for note ${note.id}:`, error);
          return null;
        })
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Small delay between batches to prevent overwhelming the system
      if (i + batchSize < notes.length) {
        await this.sleep(100);
      }
    }
    
    return results.filter(result => result !== null);
  }
}

module.exports = new PDFGenerator();
