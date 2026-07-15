'use strict';

const nodemailer = require('nodemailer');
const sgMail = require('@sendgrid/mail');
const logger = require('./logger');

/* ─────────────────────────────────────────────────────────── */
/*  SMTP Transporter (Primary)                                  */
/* ─────────────────────────────────────────────────────────── */

let transporter = null;

const buildTransporter = () => {
  const smtpPort  = parseInt(process.env.SMTP_PORT || '587', 10);
  const useSecure = smtpPort === 465;

  logger.info(`[Email] Building SMTP transporter → ${process.env.SMTP_HOST || 'smtp.gmail.com'}:${smtpPort}`);

  return nodemailer.createTransport({
    host:   (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    port:   smtpPort,
    secure: useSecure,
    requireTLS: !useSecure,
    auth: {
      user: (process.env.SMTP_USER || '').trim(),
      pass: (process.env.SMTP_PASS || '').trim(),
    },
    connectionTimeout: 20000,
    greetingTimeout:   20000,
    socketTimeout:     20000,
    tls: { rejectUnauthorized: false },
  });
};

const getTransporter = () => {
  if (!transporter) transporter = buildTransporter();
  return transporter;
};

const resetTransporter = () => {
  transporter = null;
  logger.info('[Email] Transporter reset');
};

/* ─────────────────────────────────────────────────────────── */
/*  SendGrid (Fallback — only if SENDGRID_API_KEY is set)      */
/* ─────────────────────────────────────────────────────────── */

const sendViaSendGrid = async ({ to, subject, html, text }) => {
  const apiKey = (process.env.SENDGRID_API_KEY || '').trim();
  const from   = (process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_USER || '').trim();

  if (!apiKey || !from) throw new Error('SendGrid API key or FROM email not configured');

  sgMail.setApiKey(apiKey);
  const [response] = await sgMail.send({ to, from, subject, html, text });
  return { messageId: `sg-${response.headers['x-message-id'] || Date.now()}`, provider: 'sendgrid' };
};

/* ─────────────────────────────────────────────────────────── */
/*  Universal Sender: SMTP → SendGrid fallback                  */
/* ─────────────────────────────────────────────────────────── */

const sendUniversalEmail = async ({ to, subject, html, text }) => {
  const from = process.env.EMAIL_FROM || `"EduSync 🎓" <${process.env.SMTP_USER}>`;

  if (!process.env.SMTP_USER) {
    throw new Error('SMTP_USER is not configured in environment variables.');
  }

  logger.info(`[Email] Sending to ${to}`);

  // ── 1. Try SMTP (Google App Password — works locally & on paid hosting)
  try {
    const smtp = getTransporter();
    const sendPromise    = smtp.sendMail({ from, to, subject, html, text });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SMTP timed out after 20s')), 20000)
    );
    const info = await Promise.race([sendPromise, timeoutPromise]);
    logger.info(`[Email] ✅ SMTP sent! MessageId: ${info.messageId}`);
    return { messageId: info.messageId, provider: 'smtp' };
  } catch (smtpErr) {
    logger.warn(`[Email] SMTP failed: ${smtpErr.message}`);
  }

  // ── 2. Fallback: SendGrid API
  if (process.env.SENDGRID_API_KEY) {
    try {
      logger.info(`[Email] Falling back to SendGrid...`);
      const info = await sendViaSendGrid({ to, subject, html, text });
      logger.info(`[Email] ✅ SendGrid sent! MessageId: ${info.messageId}`);
      return info;
    } catch (sgErr) {
      logger.warn(`[Email] SendGrid failed: ${sgErr.message}`);
    }
  }

  // ── Both failed
  throw new Error(`Email delivery failed: SMTP timed out and SendGrid is not configured or failed.`);
};

/* ─────────────────────────────────────────────────────────── */
/*  OTP Email — EduSync branded                                 */
/* ─────────────────────────────────────────────────────────── */

const sendOtpEmail = async (to, otp, name = 'User') => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Your EduSync OTP</title>
    </head>
    <body style="margin:0;padding:0;background:#f4f6fb;font-family:'Inter',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
              <tr>
                <td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%);padding:32px 40px;text-align:center;">
                  <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px;">EduSync</h1>
                  <p style="color:#a0b4d6;margin:4px 0 0;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Digital Classroom Platform</p>
                </td>
              </tr>
              <tr>
                <td style="padding:40px;">
                  <p style="color:#1a1a2e;font-size:16px;margin:0 0 8px;font-weight:600;">Hi ${name} 👋</p>
                  <p style="color:#555;font-size:15px;margin:0 0 24px;line-height:1.6;">
                    Your one-time verification code for EduSync is:
                  </p>
                  <div style="background:#f0f2ff;border:2px dashed #6c63ff;border-radius:12px;padding:28px;text-align:center;margin:0 0 28px;">
                    <div style="font-size:42px;font-weight:900;letter-spacing:14px;color:#1a1a2e;font-family:'Courier New',monospace;">
                      ${otp}
                    </div>
                    <p style="color:#888;font-size:12px;margin:12px 0 0;">Valid for <strong>5 minutes</strong></p>
                  </div>
                  <div style="background:#fff8e1;border-left:4px solid #ffc107;border-radius:4px;padding:12px 16px;margin-bottom:24px;">
                    <p style="color:#856404;font-size:13px;margin:0;">
                      🔒 <strong>Security Notice:</strong> Never share this OTP with anyone. EduSync will never ask for your OTP.
                    </p>
                  </div>
                  <p style="color:#aaa;font-size:13px;margin:0;line-height:1.6;">
                    If you did not request this, you can safely ignore this email. Your account is secure.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const info = await sendUniversalEmail({
    to,
    subject: `${otp} is your EduSync verification code`,
    html,
    text: `Your EduSync OTP is: ${otp}\n\nValid for 5 minutes. Do not share with anyone.`,
  });

  logger.info(`[Email] OTP sent to ${to} via ${info.provider} — MessageId: ${info.messageId}`);
  logger.info(`[DEBUG] OTP for ${to} is: ${otp}`);
  return info;
};

/* ─────────────────────────────────────────────────────────── */
/*  Session Notes Email                                         */
/* ─────────────────────────────────────────────────────────── */

const sendNotesEmail = async ({ to, name, sessionTitle, pdfUrl }) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#f4f6fb;font-family:'Inter',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
        <tr><td align="center">
          <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#1a1a2e,#0f3460);padding:32px 40px;text-align:center;">
                <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;">EduSync</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:40px;">
                <p style="color:#1a1a2e;font-size:16px;font-weight:600;margin:0 0 12px;">Hi ${name} 👋</p>
                <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px;">
                  Your notes for <strong>${sessionTitle}</strong> are ready!
                </p>
                ${pdfUrl ? `
                  <div style="text-align:center;margin:24px 0;">
                    <a href="${pdfUrl}" style="background:#6c63ff;color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
                      📥 Download PDF
                    </a>
                  </div>
                ` : ''}
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  return sendUniversalEmail({
    to,
    subject: `📚 Class Notes: ${sessionTitle}`,
    html,
    text: `Your notes for ${sessionTitle} are ready. Download: ${pdfUrl || 'N/A'}`,
  });
};

/* ─────────────────────────────────────────────────────────── */
/*  General Email                                               */
/* ─────────────────────────────────────────────────────────── */

const sendGeneralEmail = async ({ to, subject, html }) => {
  return sendUniversalEmail({ to, subject, html, text: 'Please view this in an HTML email client.' });
};

/* ─────────────────────────────────────────────────────────── */
/*  Startup config check                                        */
/* ─────────────────────────────────────────────────────────── */

const verifyEmailConfig = async () => {
  try {
    await getTransporter().verify();
    logger.info('[Email] SMTP Configuration verified successfully.');
    return true;
  } catch (err) {
    logger.warn(`[Email] SMTP verify failed: ${err.message}`);
    if (process.env.SENDGRID_API_KEY) {
      logger.info('[Email] SendGrid API key found — will use as fallback.');
    }
    return false;
  }
};

module.exports = { sendOtpEmail, sendNotesEmail, sendGeneralEmail, verifyEmailConfig, resetTransporter };
