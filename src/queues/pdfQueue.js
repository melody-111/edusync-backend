const { Queue } = require('bullmq');

// Initialize the PDF generation queue
const pdfQueue = new Queue('pdf-generation', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  }
});

/**
 * Adds a new PDF generation job to the queue
 * @param {Object} data - job data (sessionId, canvasData, ownerId)
 */
const addPdfJob = async (data) => {
  await pdfQueue.add('generate-pdf', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: {
      age: 24 * 3600, // keep failed jobs for 24 hours
    }
  });
};

module.exports = { pdfQueue, addPdfJob };
