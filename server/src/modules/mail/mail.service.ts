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

// ─── Brand palette for transactional security emails ─────────────────────────
// Enterprise Light Theme — maximises readability, passes WCAG AAA contrast.
// Contrast targets (light mode):
//   INK on white     ≈ 18:1  (titles, signatures)
//   MUTED on white   ≈  7:1  (14px body copy, WCAG AAA)
//   FAINT on white   ≈  4.6:1 (11–12px secondary hints)
//   FOOT on #F1F5F9  ≈  4.6:1 (footer small print)
// The dark-mode rules in emailShell() raise every one of these onto the dark
// surface so phone + desktop mail clients that auto-darken get the SAME readable
// palette instead of two different, half-inverted designs.
const BRAND_NAME = 'Banihal Technologies';
const BRAND_COLOR = '#2563EB';   // accent / section tags — vibrant blue
const BRAND_DARK = '#1D4ED8';    // header gradient end
const BRAND_LIGHT = '#7CB4F3';   // accents on dark surfaces (dark mode)
const INK = '#0F172A';           // headings / key values — deep navy
const MUTED = '#64748B';         // body / label text — neutral slate
const FAINT = '#64748B';         // secondary hints, info table labels
const FOOT = '#64748B';          // footer small print
const FOOT_DEAD = '#94A3B8';     // © line / decorative separators
const PAGE_BG = '#F1F5F9';       // outer canvas — soft cool gray
const CARD_BG = '#FFFFFF';       // card container — clean white
const CODE_BG = '#F8FAFC';       // code display box background
const CODE_BORDER = '#CBD5E1';   // code display box border
const NOTICE_BG = '#FFFBEB';     // security notice background
const NOTICE_BORDER = '#F59E0B'; // security notice left border
const NOTICE_TEXT = '#92400E';   // security notice body text
const COMPANY_ADDR = 'Banihal Technologies LLP · SDF Building, KITP, Kakkanchery, Kerala – 673635, India';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

const appUrl = () => env.FRONTEND_URL.replace(/\/$/, '');

// SMTP is "configured" only with a host AND a user. Note this does NOT prove the
// host is reachable — sendMail failures are reported per-email below.
const isSmtpConfigured = (): boolean => Boolean(env.SMTP_HOST && env.SMTP_USER);

// Shared shell: gradient brand header, card, signature, and a footer. Wrapped in
// a full HTML document with a dark-mode <style> block, because the phone/desktop
// "different colour" reporting is mail clients auto-darkening the message:
//
//   - The `color-scheme` meta tags + :root rule tell Apple Mail / Outlook.com /
//     modern Gmail this message is designed for BOTH palettes.
//   - The @media (prefers-color-scheme: dark) rules flip the light surfaces to
//     dark and brighten every text colour. `!important` is what lets them beat the
//     inline light-mode styles — inline styles otherwise win every specificity war.
//   - Every surface has an explicit background-color (no transparency), and text
//     colours are chosen so the same rule survives both palettes.
//
// `bodyHtml` is the email-specific card content.
function emailShell(opts: { bodyHtml: string; to: string }): string {
  const year = new Date().getFullYear();
  const base = appUrl();
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${BRAND_NAME} security notification</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 0; }
  @media (prefers-color-scheme: dark) {
    body, .page { background-color: #0B1220 !important; }
    .card { background-color: #1B2636 !important; border-color: #2C3A52 !important; }
    h1 { color: #F8FAFC !important; }
    .card p { color: #CBD5E1 !important; }
    .card span { color: #CBD5E1 !important; }
    .card td { color: #CBD5E1 !important; }
    .card a { color: #A5C4F8 !important; }
    .card li { color: #CBD5E1 !important; }
    .code-box { background-color: #0B1220 !important; border-color: #2C3A52 !important; }
    .code-digit { color: ${BRAND_LIGHT} !important; }
    .card .accent-label { color: ${BRAND_LIGHT} !important; }
    .notice { background-color: #3A2500 !important; border-left-color: #6B3D00 !important; }
    .notice .notice-title { color: #FDBA74 !important; }
    .notice li { color: #FDE68A !important; }
    .foot { color: #94A3B8 !important; }
    .foot a { color: #A5C4F8 !important; }
    .headline { color: #DBEAFE !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG};">
  <div class="page" style="margin:0;padding:0;background-color:${PAGE_BG};">
    <div style="max-width:600px;margin:0 auto;padding:24px 14px;font-family:${FONT};color:${INK};">

      <div style="background:linear-gradient(135deg,${BRAND_COLOR},${BRAND_DARK});border-radius:16px 16px 0 0;padding:22px 28px;text-align:center;">
        <div style="font-size:19px;font-weight:700;letter-spacing:0.4px;color:#ffffff;">${BRAND_NAME}</div>
        <div class="headline" style="margin-top:3px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#DBEAFE;">Security</div>
      </div>

      <div class="card" style="background-color:${CARD_BG};border:1px solid #E2E8F0;border-top:none;border-radius:0 0 16px 16px;padding:32px 28px;">
        ${opts.bodyHtml}
        <div style="margin-top:28px;padding-top:18px;border-top:1px solid #F1F5F9;">
          <p style="margin:0 0 2px;font-size:14px;color:#334155;">Stay secure,</p>
          <p style="margin:0;font-size:14px;font-weight:700;color:${INK};">The ${BRAND_NAME} Security Team</p>
        </div>
      </div>

      <div class="foot" style="padding:20px 8px 8px;text-align:center;">
        <p style="margin:0 0 12px;font-size:12px;">
          <a href="${base}/privacy" style="color:${BRAND_COLOR};text-decoration:none;font-weight:600;">Privacy Policy</a>
          <span style="color:${FOOT_DEAD};margin:0 8px;">&bull;</span>
          <a href="${base}/terms" style="color:${BRAND_COLOR};text-decoration:none;font-weight:600;">Terms &amp; Conditions</a>
        </p>
        <p style="margin:0 0 6px;font-size:11px;line-height:1.6;color:${FOOT};">
          Automated security notification sent to ${opts.to}. Please do not reply to this message.
        </p>
        <p style="margin:0 0 6px;font-size:11px;line-height:1.6;color:${FOOT};">
          This message is confidential and intended solely for the named recipient. If you received it in error, delete it and notify the sender.
        </p>
        <p style="margin:0;font-size:11px;line-height:1.6;color:${FOOT_DEAD};">&copy; ${year} ${COMPANY_ADDR}</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// Amber "security notice" box shared by both emails.
function noticeBox(items: string[]): string {
  return `
    <div class="notice" style="background:${NOTICE_BG};border:none;border-left:3px solid ${NOTICE_BORDER};border-radius:8px;padding:16px 18px;">
      <p class="notice-title" style="margin:0 0 8px;font-size:13px;font-weight:700;color:${NOTICE_TEXT};">Security notice</p>
      <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:${NOTICE_TEXT};">
        ${items.map((i) => `<li>${i}</li>`).join('')}
      </ul>
    </div>`;
}

// Shared plain-text footer (legal links + confidentiality).
function textFooter(to: string): string {
  const year = new Date().getFullYear();
  const base = appUrl();
  return [
    ``,
    `Stay secure,`,
    `The ${BRAND_NAME} Security Team`,
    ``,
    `Privacy Policy: ${base}/privacy`,
    `Terms & Conditions: ${base}/terms`,
    ``,
    `Automated security notification sent to ${to}. Please do not reply.`,
    `Confidential and intended solely for the named recipient.`,
    `(c) ${year} ${COMPANY_ADDR}`,
  ].join('\n');
}

// ─── Password reset ──────────────────────────────────────────────────────────
export function buildPasswordResetEmail(to: string, resetLink: string): { subject: string; html: string; text: string } {
  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:${MUTED};">
      We received a request to reset the password for your account. Choose a new one using the button below. This link expires in <strong>1 hour</strong> and can be used once.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px;">
      <tr><td align="center">
        <a href="${resetLink}" style="display:inline-block;padding:13px 30px;background:${BRAND_COLOR};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px;">Reset password</a>
      </td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">
      Or paste this link into your browser:<br /><span style="color:${MUTED};">${resetLink}</span>
    </p>

    ${noticeBox([
      `<strong>If you did not request a password reset,</strong> you can safely ignore this email &mdash; your password will not change.`,
      `${BRAND_NAME} will never ask you for your password or this link by phone, email, text, or chat.`,
      `Never share or forward this email; the link grants access to set a new password.`,
      `Resetting your password signs you out of all other devices and sessions.`,
    ])}`;

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
    textFooter(to),
  ].join('\n');

  return { subject: `Reset your ${BRAND_NAME} password`, html: emailShell({ bodyHtml, to }), text };
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const isConfigured = isSmtpConfigured();
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

// ─── MFA verification code ───────────────────────────────────────────────────
export function buildMfaCodeEmail(to: string, code: string, ttlMinutes: number): { subject: string; html: string; text: string } {
  // `user-select:all` makes the whole code select with a single tap/click — the
  // closest to a "copy button" achievable in email (clients strip JavaScript).
  // The underlying text is the bare 6 digits (letter-spacing is visual only).
  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">Verify your sign-in</h1>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:${MUTED};">
      Use the verification code below to finish signing in. It is valid for <strong>${ttlMinutes} minutes</strong> and can be used once.
    </p>

    <p class="accent-label" style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${BRAND_COLOR};">Your verification code</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 10px;">
      <tr>
        <td align="center" class="code-box" style="background:${CODE_BG};border:1px solid ${CODE_BORDER};border-radius:12px;padding:22px 12px;">
          <div class="code-digit" style="font-family:${MONO};font-size:42px;font-weight:700;letter-spacing:12px;color:${BRAND_COLOR};line-height:1;-webkit-user-select:all;-moz-user-select:all;user-select:all;">${code}</div>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 24px;text-align:center;font-size:12px;color:${MUTED};">Tap or click the code to select it, then copy.</p>

    ${noticeBox([
      `<strong>${BRAND_NAME} will never ask you for this code</strong> by phone, email, text, or chat. Anyone who does is trying to steal your account &mdash; do not give it to them.`,
      `Never share or forward this code, or this email, to anyone.`,
      `The code expires in ${ttlMinutes} minutes, is single-use, and completes sign-in only on the device that requested it.`,
      `<strong>If you did not just try to sign in,</strong> someone may know your password. Change it immediately and notify your administrator.`,
    ])}`;

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
    `- ${BRAND_NAME} will never ask you for this code by phone, email, text, or chat.`,
    `- Never share or forward this code to anyone.`,
    `- The code is single-use and completes sign-in only on the device that requested it.`,
    `- If you did not just try to sign in, someone may know your password. Change it immediately and notify your administrator.`,
    textFooter(to),
  ].join('\n');

  // The one-time code is NEVER placed in the subject line — subjects can surface
  // in lock-screen notifications and mail previews.
  return { subject: `Your ${BRAND_NAME} MFA verification code`, html: emailShell({ bodyHtml, to }), text };
}

export async function sendMfaCodeEmail(to: string, code: string, ttlMinutes: number): Promise<void> {
  const isConfigured = isSmtpConfigured();
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

// ─── Account invitation ──────────────────────────────────────────────────────
// Sent when an administrator creates an account for someone. Carries a temporary
// password, so it is a credential-bearing email: no link that logs anyone in, and
// the same security notice box as the rest.
export function buildInviteEmail(
  to: string,
  opts: { name: string; tempPassword: string; roleLabel: string; orgName: string },
): { subject: string; html: string; text: string } {
  const signIn = `${appUrl()}/login`;
  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">Your ${BRAND_NAME} account is ready</h1>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:${MUTED};">
      Hi ${opts.name}, an administrator created an account for you in <strong>${opts.orgName}</strong> as <strong>${opts.roleLabel}</strong>. Sign in with the temporary password below, then change it from My Profile straight away.
    </p>

    <p class="accent-label" style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${BRAND_COLOR};">Temporary password</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 10px;">
      <tr>
        <td align="center" class="code-box" style="background:${CODE_BG};border:1px solid ${CODE_BORDER};border-radius:12px;padding:20px 12px;">
          <div class="code-digit" style="font-family:${MONO};font-size:22px;font-weight:700;letter-spacing:2px;color:${BRAND_COLOR};line-height:1.3;word-break:break-all;-webkit-user-select:all;-moz-user-select:all;user-select:all;">${opts.tempPassword}</div>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 20px;text-align:center;font-size:12px;color:${MUTED};">Tap or click the password to select it, then copy.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr><td align="center">
        <a href="${signIn}" style="display:inline-block;padding:13px 30px;background:${BRAND_COLOR};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px;">Sign in</a>
      </td></tr>
    </table>

    ${noticeBox([
      `<strong>Change this password immediately after your first sign-in.</strong> Until you do, anyone holding this email can sign in as you.`,
      `${BRAND_NAME} will never ask you for your password by phone, email, text, or chat.`,
      `Never share or forward this email.`,
      `<strong>If you were not expecting this account,</strong> tell your administrator &mdash; do not sign in.`,
    ])}`;

  const text = [
    `${BRAND_NAME} — your account is ready`,
    ``,
    `Hi ${opts.name}, an administrator created an account for you in ${opts.orgName} as ${opts.roleLabel}.`,
    ``,
    `Sign in at: ${signIn}`,
    `Email:      ${to}`,
    `Temporary password: ${opts.tempPassword}`,
    ``,
    `SECURITY NOTICE`,
    `- Change this password immediately after your first sign-in.`,
    `- ${BRAND_NAME} will never ask you for your password.`,
    `- Never share or forward this email.`,
    `- If you were not expecting this account, tell your administrator and do not sign in.`,
    textFooter(to),
  ].join('\n');

  return { subject: `Your ${BRAND_NAME} account details`, html: emailShell({ bodyHtml, to }), text };
}

/**
 * Send an invitation. Unlike the two above this REPORTS delivery instead of
 * swallowing the failure: the caller shows the temporary password in the UI when
 * the mail did not go out, so a misconfigured SMTP host cannot silently produce
 * an account nobody can ever sign in to.
 */
export async function sendInviteEmail(
  to: string,
  opts: { name: string; tempPassword: string; roleLabel: string; orgName: string },
): Promise<boolean> {
  const { subject, html, text } = buildInviteEmail(to, opts);

  if (!isSmtpConfigured()) {
    console.log(`\n=============================================`);
    console.log(`[Email Mock - SMTP Not Configured] Invitation for ${to}:`);
    console.log(`   temporary password: ${opts.tempPassword}`);
    console.log(`=============================================\n`);
    return false;
  }

  try {
    await transporter.sendMail({ from: `"${BRAND_NAME}" <${env.MAIL_FROM}>`, to, subject, html, text });
    console.log(`Invitation email sent to ${to}`);
    return true;
  } catch (error) {
    console.error('Error sending invitation email:', error);
    return false;
  }
}

// ─── Email verification ──────────────────────────────────────────────────────
// Sent at self-registration to prove the mailbox belongs to whoever signed up.
// Not sent for admin-created accounts: those already receive a temporary password
// at that address (buildInviteEmail above), and are created pre-verified.
export function buildVerificationEmail(
  to: string,
  verifyLink: string,
  ttlHours: number,
): { subject: string; html: string; text: string } {
  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">Confirm your email address</h1>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:${MUTED};">
      An account was created with this email address. Confirm it to activate the account and sign in. This link expires in <strong>${ttlHours} hours</strong> and can be used once.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px;">
      <tr><td align="center">
        <a href="${verifyLink}" style="display:inline-block;padding:13px 30px;background:${BRAND_COLOR};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px;">Confirm email address</a>
      </td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">
      Or paste this link into your browser:<br /><span style="color:${MUTED};">${verifyLink}</span>
    </p>

    ${noticeBox([
      `<strong>If you did not create this account,</strong> ignore this email. Without this confirmation the account cannot be used to sign in, and it grants access to nothing.`,
      `${BRAND_NAME} will never ask you for your password or this link by phone, email, text, or chat.`,
      `Never share or forward this email; the link confirms ownership of this address.`,
    ])}`;

  const text = [
    `${BRAND_NAME} — confirm your email address`,
    ``,
    `An account was created with this email address. Confirm it to activate the`,
    `account and sign in (valid for ${ttlHours} hours, single-use):`,
    ``,
    verifyLink,
    ``,
    `SECURITY NOTICE`,
    `- If you did not create this account, ignore this email. Unconfirmed, it cannot sign in.`,
    `- ${BRAND_NAME} will never ask you for your password or this link.`,
    `- Never share or forward this email.`,
    textFooter(to),
  ].join('\n');

  return { subject: `Confirm your ${BRAND_NAME} email address`, html: emailShell({ bodyHtml, to }), text };
}

/**
 * Send the verification link. REPORTS delivery rather than swallowing the failure,
 * for the same reason sendInviteEmail does: login is gated on this email arriving,
 * so a silent SMTP failure would leave an account that can never be signed in to.
 * The caller surfaces the result so the UI can offer "resend" immediately.
 */
export async function sendVerificationEmail(to: string, verifyLink: string, ttlHours: number): Promise<boolean> {
  const { subject, html, text } = buildVerificationEmail(to, verifyLink, ttlHours);

  if (!isSmtpConfigured()) {
    console.log(`\n=============================================`);
    console.log(`[Email Mock - SMTP Not Configured] Email verification link for ${to}:`);
    console.log(`${verifyLink}`);
    console.log(`=============================================\n`);
    return false;
  }

  try {
    await transporter.sendMail({ from: `"${BRAND_NAME} Security" <${env.MAIL_FROM}>`, to, subject, html, text });
    console.log(`Verification email sent to ${to}`);
    return true;
  } catch (error) {
    console.error('Error sending verification email:', error);
    return false;
  }
}

// ─── Organization approval code ──────────────────────────────────────────────
// Sent to a PLATFORM STAFF member, not to a customer. They are the approver: the
// code in this email is what admits a newly-registered organization, and they are
// expected to read it aloud to that organization's admin once satisfied the
// signup is genuine.
//
// The details of the registering org are included precisely because that decision
// cannot be made from a bare code — the recipient needs to know who is asking.
export interface OrgApprovalDetails {
  orgName: string;
  contactPerson: string;
  contactEmail: string;
  domain: string | null;
}

export function buildOrgApprovalEmail(
  to: string,
  code: string,
  org: OrgApprovalDetails,
  ttlMinutes: number,
): { subject: string; html: string; text: string } {
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:${FAINT};width:130px;">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:${INK};font-weight:600;">${value}</td>
    </tr>`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${INK};">Approve a new organization</h1>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:${MUTED};">
      <strong>${org.orgName}</strong> has registered and confirmed its email address. It cannot sign in
      until you pass the code below to its administrator.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;border-collapse:collapse;">
      ${row('Organization', org.orgName)}
      ${row('Administrator', org.contactPerson)}
      ${row('Email', org.contactEmail)}
      ${row('Domain', org.domain ?? '&mdash;')}
    </table>

    <p class="accent-label" style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${BRAND_COLOR};">Approval code</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 10px;">
      <tr>
        <td align="center" class="code-box" style="background:${CODE_BG};border:1px solid ${CODE_BORDER};border-radius:12px;padding:22px 12px;">
          <div class="code-digit" style="font-family:${MONO};font-size:42px;font-weight:700;letter-spacing:12px;color:${BRAND_COLOR};line-height:1;-webkit-user-select:all;-moz-user-select:all;user-select:all;">${code}</div>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 24px;text-align:center;font-size:12px;color:${MUTED};">Valid for ${ttlMinutes} minutes. The administrator can request a new one if it expires.</p>

    ${noticeBox([
      `<strong>Verify who you are speaking to before sharing this code.</strong> It is the only thing standing between a stranger and an account on this platform.`,
      `Read it aloud on a call you initiated, or send it through a channel you already trust. <strong>Do not forward this email.</strong>`,
      `Share it only with the administrator named above &mdash; never with anyone who contacts you asking for it.`,
      `<strong>If you do not recognise this organization,</strong> do nothing. Withholding the code is how a registration is refused; it expires on its own.`,
    ])}`;

  const text = [
    `${BRAND_NAME} — approve a new organization`,
    ``,
    `${org.orgName} has registered and confirmed its email address. It cannot sign in`,
    `until you pass the code below to its administrator.`,
    ``,
    `  Organization:   ${org.orgName}`,
    `  Administrator:  ${org.contactPerson}`,
    `  Email:          ${org.contactEmail}`,
    `  Domain:         ${org.domain ?? '-'}`,
    ``,
    `Approval code:`,
    ``,
    `    ${code}`,
    ``,
    `Valid for ${ttlMinutes} minutes. The administrator can request a new one if it expires.`,
    ``,
    `SECURITY NOTICE`,
    `- Verify who you are speaking to before sharing this code.`,
    `- Read it aloud on a call you initiated, or use a channel you already trust. Do not forward this email.`,
    `- Share it only with the administrator named above.`,
    `- If you do not recognise this organization, do nothing. Withholding the code refuses the registration.`,
    textFooter(to),
  ].join('\n');

  // The code is never in the subject line — subjects surface in lock-screen
  // previews, and this one admits an entire organization.
  return {
    subject: `Approval needed: ${org.orgName} wants to join ${BRAND_NAME}`,
    html: emailShell({ bodyHtml, to }),
    text,
  };
}

/**
 * Send one approver their copy of the code. REPORTS delivery rather than swallowing
 * it, like sendVerificationEmail: the whole approval flow is gated on at least one
 * of these arriving, so the caller needs to know whether any did.
 */
export async function sendOrgApprovalEmail(
  to: string,
  code: string,
  org: OrgApprovalDetails,
  ttlMinutes: number,
): Promise<boolean> {
  const { subject, html, text } = buildOrgApprovalEmail(to, code, org, ttlMinutes);

  if (!isSmtpConfigured()) {
    console.log(`\n=============================================`);
    console.log(`[Email Mock - SMTP Not Configured] Org approval code for ${to}:`);
    console.log(`   ${code}   (${org.orgName}, expires in ${ttlMinutes} minutes)`);
    console.log(`=============================================\n`);
    return false;
  }

  try {
    await transporter.sendMail({ from: `"${BRAND_NAME} Security" <${env.MAIL_FROM}>`, to, subject, html, text });
    console.log(`Org approval email sent to ${to}`);
    return true;
  } catch (error) {
    console.error('Error sending org approval email:', error);
    return false;
  }
}
