/**
 * Consumer, free-mail and disposable mailbox providers.
 *
 * An address on one of these is not a work address, so registration refuses it —
 * strictly, with no exceptions: there is deliberately NO environment override, no
 * allowlist, and no bypass for domains listed in ADMIN_DOMAINS. Editing this list
 * is a code change and a deploy, by design.
 *
 * This is a first-pass filter that reduces reviewer load, NOT the security
 * boundary. Anyone with a cheap domain and a catch-all inbox is indistinguishable
 * from a real company to any list-based check; what actually establishes
 * legitimacy is the organization approval flow (orgApproval.service.ts), where a
 * human admits each new org with an out-of-band code.
 *
 * See docs/decisions/ADR-001-work-email-domain-filtration.md for the alternatives
 * that were rejected (MX lookups, npm blocklists, a DB-backed table).
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'outlook.com', 'outlook.in',
  'live.com', 'live.co.uk', 'msn.com',
  // Yahoo / AOL
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.fr', 'ymail.com',
  'rocketmail.com', 'aol.com', 'aim.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Privacy-focused consumer mail
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io', 'hushmail.com',
  // Other global consumer providers
  'zoho.com', 'zohomail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com',
  'fastmail.com', 'inbox.com', 'yandex.com', 'yandex.ru', 'mail.ru',
  'rediffmail.com', 'naver.com', 'qq.com', '163.com', '126.com', 'sina.com',
  // ISP-issued personal mailboxes
  'comcast.net', 'verizon.net', 'att.net', 'bellsouth.net', 'sbcglobal.net',
  'cox.net', 'btinternet.com', 'orange.fr', 'free.fr', 'web.de', 't-online.de',
  'libero.it',
  // Disposable / throwaway. Not exhaustive and cannot be — these services rotate
  // domains continuously. Covers the ones people actually reach for.
  'mailinator.com', 'guerrillamail.com', 'sharklasers.com', 'grr.la',
  'guerrillamailblock.com', 'pokemail.net', 'spam4.me', '10minutemail.com',
  'yopmail.com', 'temp-mail.org', 'tempmail.com', 'trashmail.com',
  'dispostable.com', 'getnada.com', 'maildrop.cc', 'throwawaymail.com',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com',
]);

/** The lowercased domain part of an address, or null if there isn't one. */
export function emailDomain(email: string): string | null {
  return email.split('@')[1]?.toLowerCase().trim() || null;
}

/** True when the address belongs to a consumer, free-mail or disposable provider. */
export function isPersonalEmailDomain(email: string): boolean {
  const domain = emailDomain(email);
  return !!domain && PERSONAL_EMAIL_DOMAINS.has(domain);
}
