'use strict';

const express = require('express');
const router = express.Router();

const { pushSyncItems, getSyncStatus, retryFailed, pushSyncValidation } = require('../controllers/syncController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

router.use(authenticate);

router.post('/push', pushSyncValidation, validate, pushSyncItems);
router.get('/status', getSyncStatus);
router.post('/retry', retryFailed);

module.exports = router;
