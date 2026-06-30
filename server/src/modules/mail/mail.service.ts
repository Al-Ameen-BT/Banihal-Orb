import nodemailer from 'nodemailer';
import { env } from '../../config/env';

// Create a transport using SMTP credentials if provided
const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465, // true for 465, false for other ports
  auth: (env.SMTP_USER && env.SMTP_PASS) ? {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  } : undefined,
  tls: {
    ciphers: 'SSLv3',
    rejectUnauthorized: false
  }
});

// Brand identity for transactional security emails.
const BRAND_NAME = 'Banihal Technologies';
const BRAND_COLOR = '#2563EB';

// Pure renderer for the password-reset email — no side effects, so it can be
// previewed and unit-tested without sending.
export function buildPasswordResetEmail(to: string, resetLink: string): { subject: string; html: string; text: string } {
  const year = new Date().getFullYear();

  const html = `
  <div style="margin:0;padding:0;background:#f1f5f9;">
    <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
      <div style="text-align:center;padding:8px 0 20px;">
        <span style="display:inline-block;font-size:18px;font-weight:700;letter-spacing:0.5px;color:${BRAND_COLOR};">${BRAND_NAME}</span>
      </div>

      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:32px 28px;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#0f172a;">Reset your password</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#475569;">
          We received a request to reset the password for your account. Click the button below to choose a new one. This link expires in <strong>1 hour</strong> and can be used once.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px;">
          <tr><td align="center">
            <a href="${resetLink}" style="display:inline-block;padding:12px 28px;background:${BRAND_COLOR};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px;">Reset password</a>
          </td></tr>
        </table>
        <p style="margin:0 0 24px;font-size:12px;line-height:1.6;color:#94a3b8;word-break:break-all;">
          Or paste this link into your browser:<br /><span style="color:#475569;">${resetLink}</span>
        </p>

        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px 18px;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#9a3412;">Security notice</p>
          <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:#7c2d12;">
            <li><strong>If you did not request a password reset,</strong> you can safely ignore this email &mdash; your password will not change. Consider reviewing your account if you receive these unexpectedly.</li>
            <li>${BRAND_NAME} will never ask you for your password or this link by phone, email, text, or chat.</li>
            <li>Never share or forward this email; the link grants access to set a new password.</li>
            <li>Resetting your password signs you out of all other devices and sessions.</li>
          </ul>
        </div>
      </div>

      <div style="padding:24px 6px 8px;">
        <p style="margin:0 0 2px;font-size:14px;color:#334155;">Stay secure,</p>
        <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">The ${BRAND_NAME} Security Team</p>
      </div>

      <div style="border-top:1px solid #e2e8f0;margin-top:8px;padding:16px 6px 0;">
        <p style="margin:0 0 6px;font-size:11px;line-height:1.6;color:#94a3b8;">
          This is an automated security notification sent to ${to}. Please do not reply to this message.
        </p>
        <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8;">
          &copy; ${year} ${BRAND_NAME}. This message and the link it contains are confidential and intended solely for the named recipient. If you received this email in error, delete it and notify the sender immediately.
        </p>
      </div>
    </div>
  </div>`;

  const text = [
    `${BRAND_NAME} — reset your password`,
    ``,
    `We received a request to reset the password for your account.`,
    `Open this link to choose a new password (valid for 1 hour, single-use):`,
    ``,
    resetLink,
    ``,
    `SECURITY NOTICE`,
    `- If you did not request this, ignore this email; your password will not change.`,
    `- ${BRAND_NAME} will never ask you for your password or this link.`,
    `- Never share or forward this email.`,
    `- Resetting your password signs you out of all other devices.`,
    ``,
    `Stay secure,`,
    `The ${BRAND_NAME} Security Team`,
    ``,
    `This is an automated security notification sent to ${to}. Please do not reply.`,
    `(c) ${year} ${BRAND_NAME}. Confidential and intended solely for the named recipient.`,
  ].join('\n');

  return { subject: `Reset your ${BRAND_NAME} password`, html, text };
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const isConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER);
  const { subject, html, text } = buildPasswordResetEmail(to, resetLink);

  if (!isConfigured) {
    console.log(`\n=============================================`);
    console.log(`[Email Mock - SMTP Not Configured] Password Reset Link for ${to}:`);
    console.log(`${resetLink}`);
    console.log(`=============================================\n`);
    return;
  }

  const mailOptions = { from: `"${BRAND_NAME} Security" <${env.MAIL_FROM}>`, to, subject, html, text };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Password reset email sent to ${to}`);
  } catch (error) {
    console.error('Error sending password reset email:', error);
  }
}

// Pure renderer for the MFA email — no side effects, so it can be previewed and
// unit-tested without sending. sendMfaCodeEmail wraps it with the transport.
export function buildMfaCodeEmail(to: string, code: string, ttlMinutes: number): { subject: string; html: string; text: string } {
  const year = new Date().getFullYear();

  // `user-select:all` makes the whole code select with a single tap/click — the
  // closest to a "copy button" achievable in email (clients strip JavaScript, so
  // a real clipboard button can't run). The code's underlying text is the bare
  // 6 digits (letter-spacing is visual only), so copying yields a clean value.
  const html = `
  <div style="margin:0;padding:0;background:#f1f5f9;">
    <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
      <div style="text-align:center;padding:8px 0 20px;">
        <span style="display:inline-block;font-size:18px;font-weight:700;letter-spacing:0.5px;color:${BRAND_COLOR};">${BRAND_NAME}</span>
      </div>

      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:32px 28px;">
        <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#0f172a;">Verify your sign-in</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#475569;">
          Enter the verification code below to finish signing in. It is valid for <strong>${ttlMinutes} minutes</strong> and can be used once.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px;">
          <tr>
            <td align="center" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px 12px;">
              <div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:40px;font-weight:700;letter-spacing:10px;color:#0f172a;line-height:1;-webkit-user-select:all;-moz-user-select:all;user-select:all;">${code}</div>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 24px;text-align:center;font-size:12px;color:#94a3b8;">Tap or click the code to select it, then copy.</p>

        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px 18px;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#9a3412;">Security notice</p>
          <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:#7c2d12;">
            <li><strong>${BRAND_NAME} will never ask you for this code</strong> by phone, email, text, or chat. Anyone who does is trying to steal your account &mdash; do not give it to them.</li>
            <li>Never share or forward this code, or this email, to anyone.</li>
            <li>The code expires in ${ttlMinutes} minutes, is single-use, and completes sign-in only on the device that requested it.</li>
            <li><strong>If you did not just try to sign in,</strong> someone may know your password. Change it immediately and notify your administrator.</li>
          </ul>
        </div>
      </div>

      <div style="padding:24px 6px 8px;">
        <p style="margin:0 0 2px;font-size:14px;color:#334155;">Stay secure,</p>
        <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">The ${BRAND_NAME} Security Team</p>
      </div>

      <div style="border-top:1px solid #e2e8f0;margin-top:8px;padding:16px 6px 0;">
        <p style="margin:0 0 6px;font-size:11px;line-height:1.6;color:#94a3b8;">
          This is an automated security notification sent to ${to}. Please do not reply to this message.
        </p>
        <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8;">
          &copy; ${year} ${BRAND_NAME}. This message and the verification code it contains are confidential and intended solely for the named recipient. If you received this email in error, delete it and notify the sender immediately.
        </p>
      </div>
    </div>
  </div>`;

  // Plain-text alternative (better deliverability + trivial to copy).
  const text = [
    `${BRAND_NAME} — verify your sign-in`,
    ``,
    `Your verification code is:`,
    ``,
    `    ${code}`,
    ``,
    `It is valid for ${ttlMinutes} minutes and can be used once.`,
    ``,
    `SECURITY NOTICE`,
    `- ${BRAND_NAME} will never ask you for this code by phone, email, text, or chat. Anyone who does is trying to steal your account.`,
    `- Never share or forward this code to anyone.`,
    `- The code is single-use and completes sign-in only on the device that requested it.`,
    `- If you did not just try to sign in, someone may know your password. Change it immediately and notify your administrator.`,
    ``,
    `Stay secure,`,
    `The ${BRAND_NAME} Security Team`,
    ``,
    `This is an automated security notification sent to ${to}. Please do not reply.`,
    `(c) ${year} ${BRAND_NAME}. This message and the code it contains are confidential and intended solely for the named recipient. If received in error, delete it and notify the sender.`,
  ].join('\n');

  return { subject: `${code} is your ${BRAND_NAME} sign-in code`, html, text };
}

export async function sendMfaCodeEmail(to: string, code: string, ttlMinutes: number): Promise<void> {
  const isConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER);
  const { subject, html, text } = buildMfaCodeEmail(to, code, ttlMinutes);

  if (!isConfigured) {
    console.log(`\n=============================================`);
    console.log(`[Email Mock - SMTP Not Configured] Login verification code for ${to}:`);
    console.log(`   ${code}   (expires in ${ttlMinutes} minutes)`);
    console.log(`=============================================\n`);
    return;
  }

  const mailOptions = { from: `"${BRAND_NAME} Security" <${env.MAIL_FROM}>`, to, subject, html, text };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`MFA code email sent to ${to}`);
  } catch (error) {
    console.error('Error sending MFA code email:', error);
  }
}
