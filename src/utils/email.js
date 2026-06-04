'use strict';

const nodemailer = require('nodemailer');
const logger = require('./logger');
const axios = require('axios');

let transporter = null;

const buildTransporter = () => {
  const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const useSecure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : smtpPort === 465;

  const config = {
    host: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    port: smtpPort,
    secure: useSecure,
    auth: {
      user: (process.env.SMTP_USER || 'sudhanshusonkar210@gmail.com').trim(),
      pass: (process.env.SMTP_PASS || 'lscsqhdoxrxdngdp').trim(),
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
    tls: {
      rejectUnauthorized: false,
    },
  };

  if (!useSecure) {
    config.requireTLS = true;
  }

  logger.info(`[Email] Building SMTP fallback transporter: ${config.host}:${smtpPort}`);
  return nodemailer.createTransport(config);
};

const getTransporter = () => {
  if (!transporter) {
    transporter = buildTransporter();
  }
  return transporter;
};

const resetTransporter = () => {
  transporter = null;
  logger.info('[Email] Transporter reset');
};

/**
 * Universal email sender that tries HTTP APIs (Resend, SendGrid) before falling back to SMTP.
 * Render blocks SMTP, so HTTP APIs guarantee delivery in production.
 */
const sendUniversalEmail = async ({ to, subject, html, text, fromOverride }) => {
  const from = fromOverride || process.env.EMAIL_FROM || '"EduSync 🎓" <noreply@edusync.app>';
  
  // 1. Resend HTTP API
  if (process.env.RESEND_API_KEY) {
    logger.info(`[Email] Sending via Resend API to ${to}`);
    try {
      const res = await axios.post('https://api.resend.com/emails', {
        from, to, subject, html, text
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      return { messageId: res.data.id, provider: 'resend' };
    } catch (err) {
      // Resend failed (e.g. domain not verified) — fall through to SMTP
      logger.warn(`[Email] Resend API failed: ${err.response?.data?.message || err.message}. Falling back to SMTP...`);
    }
  }
  
  // 2. SendGrid HTTP API
  if (process.env.SENDGRID_API_KEY) {
    logger.info(`[Email] Sending via SendGrid API to ${to}`);
    // SendGrid requires a specific 'from' object format if the user provided name & email
    let fromEmail = from;
    let fromName = '';
    const match = from.match(/"?([^"]+)"?\s*<([^>]+)>/);
    if (match) {
      fromName = match[1];
      fromEmail = match[2];
    }
    
    try {
      const res = await axios.post('https://api.sendgrid.com/v3/mail/send', {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: fromName },
        subject,
        content: [
          ...(text ? [{ type: 'text/plain', value: text }] : []),
          { type: 'text/html', value: html }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      return { messageId: res.headers['x-message-id'] || 'sendgrid-success', provider: 'sendgrid' };
    } catch (err) {
      const sgErr = err.response?.data?.errors?.[0]?.message || err.message;
      logger.error(`[Email] SendGrid API failed: ${sgErr}`);
      throw new Error(`SendGrid API Error: ${sgErr}`);
    }
  }

  // 3. Fallback to SMTP (Nodemailer)
  logger.info(`[Email] Sending via SMTP (Fallback) to ${to}`);
  const info = await getTransporter().sendMail({ from, to, subject, html, text });
  return { messageId: info.messageId, provider: 'smtp' };
};

/**
 * Send an OTP email — EduSync branded
 */
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
  return info;
};

/**
 * Send session PDF / notes email
 */
const sendNotesEmail = async ({ to, name, sessionTitle, pdfUrl, attachmentPath }) => {
  // If attachmentPath is provided, SendGrid/Resend API needs different formatting for attachments.
  // For simplicity, we just fallback to SMTP if attachments are strictly required and API keys are not used,
  // OR we assume pdfUrl is mostly used. (We skip attachments in HTTP API for now to keep it simple, 
  // as pdfUrl is the primary delivery method).
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#f4f6fb;font-family:'Inter',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
        <tr>
          <td align="center">
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
                    Your notes for <strong>${sessionTitle}</strong> have been saved and are ready!
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
          </td>
        </tr>
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

/**
 * Send a general notification email
 */
const sendGeneralEmail = async ({ to, subject, html }) => {
  return sendUniversalEmail({
    to,
    subject,
    html,
    text: 'Please view this email in an HTML-compatible email client.',
  });
};

const verifyEmailConfig = async () => {
  if (process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY) {
    logger.info('[Email] Using HTTP API for emails (SMTP bypassed) ✓');
    return true;
  }
  try {
    await getTransporter().verify();
    logger.info('[Email] SMTP connection verified ✓');
    return true;
  } catch (err) {
    logger.warn(`[Email] SMTP verify failed: ${err.message}`);
    return false;
  }
};

module.exports = { sendOtpEmail, sendNotesEmail, sendGeneralEmail, verifyEmailConfig, resetTransporter };
