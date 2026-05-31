const express = require('express');
const router = express.Router();
const { sendOtpEmail } = require('../utils/email');

router.get('/test', async (req, res) => {
  try {
    const info = await sendOtpEmail('sudhanshusonkar210@gmail.com', '123456', 'Render Test');
    res.json({ success: true, info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

module.exports = router;
