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
 * Normalize phone number into international E.164 format (+91...)
 * @param {string} phone
 * @returns {string}
 */
const formatPhoneNumber = (phone) => {
  if (!phone) return '';
  let clean = String(phone).replace(/[\s\-()]/g, '');
  if (/^\d{10}$/.test(clean)) {
    return '+91' + clean;
  }
  if (!clean.startsWith('+')) {
    return '+' + clean;
  }
  return clean;
};

/**
 * Send an OTP to a phone number using Twilio SMS
 * @param {string} phone - The recipient's phone number
 * @param {string} otp - The 6-digit OTP code
 */
const sendOtpSms = async (phone, otp) => {
  const formattedPhone = formatPhoneNumber(phone);
  if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) {
    logger.warn(`[SMS] Twilio client not configured. Simulated dispatch for ${formattedPhone}`);
    return { sid: 'dispatch-sms-' + Date.now(), to: formattedPhone, simulated: true };
  }

  try {
    const message = await twilioClient.messages.create({
      body: `Your EduSync verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: formattedPhone,
    });
    
    logger.info(`[SMS] OTP SMS successfully sent to ${formattedPhone} (SID: ${message.sid})`);
    return message;
  } catch (error) {
    logger.error(`[SMS] Failed to send SMS to ${formattedPhone}: ${error.message}`);
    throw new Error(`Failed to send SMS OTP to ${formattedPhone}: ${error.message}`);
  }
};

/**
 * Send an OTP via WhatsApp using Twilio
 * @param {string} phone - The recipient's phone number
 * @param {string} otp - The 6-digit OTP code
 */
const sendWhatsAppOtp = async (phone, otp) => {
  const formattedPhone = formatPhoneNumber(phone);
  if (!twilioClient) {
    logger.warn(`[WhatsApp] Twilio client not configured. Simulated dispatch for ${formattedPhone}`);
    return { sid: 'dispatch-wa-' + Date.now(), to: formattedPhone, simulated: true };
  }

  // Use sandbox sender number (TWILIO_WHATSAPP_FROM) or fallback to Twilio sandbox default
  const fromNumber = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || '+14155238886'}`;
  const toNumber = `whatsapp:${formattedPhone}`;

  try {
    const message = await twilioClient.messages.create({
      body: `*EduSync*\nYour verification code is: *${otp}*.\n\nValid for 5 minutes. Do not share this code.`,
      from: fromNumber,
      to: toNumber,
    });
    logger.info(`[WhatsApp] OTP sent to ${formattedPhone} (SID: ${message.sid})`);
    return message;
  } catch (error) {
    logger.error(`[WhatsApp] Failed to send WhatsApp message to ${formattedPhone}: ${error.message}`);
    throw new Error(`Failed to send WhatsApp OTP to ${formattedPhone}: ${error.message}`);
  }
};

/**
 * Dispatches OTP to phone via SMS (primary) with WhatsApp as fallback
 * @param {string} phone 
 * @param {string} otp 
 */
const sendOtpPhone = async (phone, otp) => {
  const formatted = formatPhoneNumber(phone);
  try {
    const res = await sendOtpSms(formatted, otp);
    return { success: true, method: 'sms', to: formatted, sid: res?.sid };
  } catch (smsErr) {
    logger.warn(`[SMS] SMS delivery failed for ${formatted}: ${smsErr.message}. Trying WhatsApp fallback...`);
    try {
      const waRes = await sendWhatsAppOtp(formatted, otp);
      return { success: true, method: 'whatsapp', to: formatted, sid: waRes?.sid };
    } catch (waErr) {
      logger.error(`[SMS] Both SMS and WhatsApp failed for ${formatted}`);
      throw smsErr;
    }
  }
};

module.exports = {
  formatPhoneNumber,
  sendOtpSms,
  sendWhatsAppOtp,
  sendOtpPhone,
};
