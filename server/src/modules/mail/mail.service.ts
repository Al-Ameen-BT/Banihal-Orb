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

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const isConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER);

  if (!isConfigured) {
    console.log(`\n=============================================`);
    console.log(`[Email Mock - SMTP Not Configured] Password Reset Link for ${to}:`);
    console.log(`${resetLink}`);
    console.log(`=============================================\n`);
    return;
  }

  const mailOptions = {
    from: env.MAIL_FROM,
    to,
    subject: 'Password Reset Request',
    html: `
      <h2>Password Reset Request</h2>
      <p>We received a request to reset your password. If you didn't make this request, you can safely ignore this email.</p>
      <p>Click the link below to set a new password:</p>
      <a href="${resetLink}" style="display:inline-block;padding:10px 20px;background-color:#007bff;color:#fff;text-decoration:none;border-radius:5px;">Reset Password</a>
      <p><br>Or copy and paste this link into your browser:</p>
      <p>${resetLink}</p>
      <hr style="border:none;border-top:1px solid #eaeaea;margin:20px 0;" />
      <p><small style="color:#666;">This link will expire in 1 hour.</small></p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Password reset email sent to ${to}`);
  } catch (error) {
    console.error('Error sending password reset email:', error);
  }
}
