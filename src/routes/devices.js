'use strict';

const express = require('express');
const router = express.Router();

const {
  registerDevice, getMyDevices, getDevice,
  updateDeviceStatus, deactivateDevice,
  registerDeviceValidation,
  deviceIdParamValidation,
  updateDeviceStatusValidation,
} = require('../controllers/deviceController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

router.use(authenticate);

router.post('/register', registerDeviceValidation, validate, registerDevice);
router.get('/', getMyDevices);
router.get('/:deviceId', deviceIdParamValidation, validate, getDevice);
router.patch('/:deviceId/status', updateDeviceStatusValidation, validate, updateDeviceStatus);
router.delete('/:deviceId', deviceIdParamValidation, validate, deactivateDevice);

module.exports = router;
