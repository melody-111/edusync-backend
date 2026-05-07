'use strict';

const express = require('express');
const router = express.Router();
const { getUserNotes } = require('../controllers/fileController');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');

router.use(authenticate);
router.use(apiLimiter);

router.get('/', getUserNotes);

module.exports = router;
