'use strict';

const twilio = require('twilio');
const logger = require('./logger');

let twilioClient = null;

if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    logger.info('Twilio client initialized.');
  } catch (err) {
    logger.error(`Failed to initialize Twilio client: ${err.message}`);
  }
}

/**
 * Send an OTP to a phone number using Twilio SMS
 * @param {string} phone - The recipient's phone number (with country code, e.g. +919876543210)
 * @param {string} otp - The 6-digit OTP code
 */
const sendOtpSms = async (phone, otp) => {
  if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) {
    logger.warn(`Twilio not configured. Would have sent OTP ${otp} to ${phone}`);
    return;
  }

  try {
    const message = await twilioClient.messages.create({
      body: `Your EduSync verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
    
    logger.info(`OTP SMS sent to ${phone} (SID: ${message.sid})`);
    return message;
  } catch (error) {
    logger.error(`Failed to send SMS to ${phone}: ${error.message}`);
    throw new Error('Failed to send SMS OTP. Please try again or use email.');
  }
};

/**
 * Send an OTP via WhatsApp using Twilio
 * @param {string} phone - The recipient's phone number (with country code, e.g. +919876543210)
 * @param {string} otp - The 6-digit OTP code
 */
const sendWhatsAppOtp = async (phone, otp) => {
  if (!twilioClient) {
    logger.warn(`Twilio not configured. Would have sent WhatsApp OTP ${otp} to ${phone}`);
    return;
  }

  // Use sandbox sender number (TWILIO_WHATSAPP_FROM) or fallback to Twilio sandbox default
  const fromNumber = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || '+14155238886'}`;
  const toNumber = `whatsapp:${phone}`;

  try {
    const message = await twilioClient.messages.create({
      body: `*EduSync*\nYour verification code is: *${otp}*.\n\nValid for 5 minutes. Do not share this code.`,
      from: fromNumber,
      to: toNumber,
    });
    logger.info(`WhatsApp OTP sent to ${phone} (SID: ${message.sid})`);
    return message;
  } catch (error) {
    logger.error(`Failed to send WhatsApp message to ${phone}: ${error.message}`);
    throw new Error('Failed to send WhatsApp OTP. Please try again or use email.');
  }
};

module.exports = {
  sendOtpSms,
  sendWhatsAppOtp,
};
