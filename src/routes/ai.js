'use strict';

const express = require('express');
const router = express.Router();

const { aiChat, generateImage, getAiUsage, aiChatValidation, generateImageValidation } = require('../controllers/aiController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { aiLimiter } = require('../middleware/rateLimiter');

router.use(authenticate);

router.post('/chat', aiLimiter, aiChatValidation, validate, aiChat);
router.post('/generate-image', aiLimiter, generateImageValidation, validate, generateImage);
router.get('/usage', getAiUsage);

module.exports = router;
