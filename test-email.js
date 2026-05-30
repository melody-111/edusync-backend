require('dotenv').config();
const { sendOtpEmail } = require('./src/utils/email');

async function test() {
  try {
    console.log('Sending test email...');
    await sendOtpEmail('sudhanshusonkar210@gmail.com', '123456');
    console.log('Test email sent successfully!');
  } catch (err) {
    console.error('Test email failed:', err.message);
  }
}
test();
