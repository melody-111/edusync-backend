'use strict';

const express = require('express');
const router = express.Router();

const { searchVideos, getVideoDetails } = require('../controllers/youtubeController');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { query, param } = require('express-validator');
const { validate } = require('../middleware/validate');

router.use(authenticate);
router.use(apiLimiter);

/**
 * @swagger
 * tags:
 *   name: YouTube
 *   description: YouTube video search and details
 */

// GET /youtube/search — search YouTube videos
router.get(
  '/search',
  [
    query('query').notEmpty().withMessage('Query is required'),
    query('maxResults').optional().isInt({ min: 1, max: 50 }).withMessage('Max results must be between 1 and 50'),
    query('pageToken').optional().isString(),
  ],
  validate,
  searchVideos
);

// GET /youtube/video/:videoId — get video details
router.get(
  '/video/:videoId',
  [
    param('videoId').notEmpty().withMessage('Video ID is required'),
  ],
  validate,
  getVideoDetails
);

module.exports = router;
