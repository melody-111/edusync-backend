'use strict';

const nodemailer = require('nodemailer');
const logger = require('./logger');

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });

  return transporter;
};

/**
 * Send an OTP email
 */
const sendOtpEmail = async (to, otp, name = 'User') => {
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f9f9fb;border-radius:12px;">
      <h2 style="color:#1a1a2e;margin-bottom:8px;">Digital Classroom</h2>
      <p style="color:#555;font-size:15px;">Hi ${name},</p>
      <p style="color:#555;font-size:15px;">Your login OTP is:</p>
      <div style="background:#1a1a2e;color:#fff;font-size:36px;font-weight:700;letter-spacing:12px;padding:24px;text-align:center;border-radius:8px;margin:24px 0;">
        ${otp}
      </div>
      <p style="color:#888;font-size:13px;">This OTP is valid for <strong>5 minutes</strong>. Do not share it with anyone.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0;" />
      <p style="color:#aaa;font-size:12px;">If you did not request this, ignore this email.</p>
    </div>
  `;

  return getTransporter().sendMail({
    from: process.env.EMAIL_FROM || '"Digital Classroom" <noreply@classroom.app>',
    to,
    subject: `${otp} — Your OTP for Digital Classroom`,
    html,
  });
};

/**
 * Send session PDF / notes email
 */
const sendNotesEmail = async ({ to, name, sessionTitle, pdfUrl, attachmentPath }) => {
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#f9f9fb;border-radius:12px;">
      <h2 style="color:#1a1a2e;">Your Class Notes are Ready</h2>
      <p style="color:#555;font-size:15px;">Hi ${name},</p>
      <p style="color:#555;font-size:15px;">Notes for <strong>${sessionTitle}</strong> have been saved and are ready to download.</p>
      ${pdfUrl ? `<a href="${pdfUrl}" style="display:inline-block;background:#6c63ff;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Download PDF</a>` : ''}
      <p style="color:#aaa;font-size:12px;margin-top:24px;">This link expires in 30 days.</p>
    </div>
  `;

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"Digital Classroom" <noreply@classroom.app>',
    to,
    subject: `Class Notes: ${sessionTitle}`,
    html,
  };

  if (attachmentPath) {
    mailOptions.attachments = [
      {
        filename: `${sessionTitle.replace(/\s+/g, '_')}_notes.pdf`,
        path: attachmentPath,
        contentType: 'application/pdf',
      },
    ];
  }

  return getTransporter().sendMail(mailOptions);
};

/**
 * Send a general notification email
 */
const sendGeneralEmail = async ({ to, subject, html }) => {
  return getTransporter().sendMail({
    from: process.env.EMAIL_FROM || '"Digital Classroom" <noreply@classroom.app>',
    to,
    subject,
    html,
  });
};

const verifyEmailConfig = async () => {
  try {
    await getTransporter().verify();
    logger.info('SMTP connection verified');
    return true;
  } catch (err) {
    logger.warn(`SMTP verify failed: ${err.message}`);
    return false;
  }
};

module.exports = { sendOtpEmail, sendNotesEmail, sendGeneralEmail, verifyEmailConfig };
