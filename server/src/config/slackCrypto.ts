import crypto from 'crypto';
import { env } from './env';

// AES-256-GCM encryption for Slack bot tokens at rest. The key is derived from
// SLACK_TOKEN_SECRET (falling back to JWT_ACCESS_SECRET) via SHA-256 so any
// sufficiently long secret works. Ciphertext format: iv:authTag:cipher (all hex).
const KEY = crypto.createHash('sha256').update(env.SLACK_TOKEN_SECRET ?? env.JWT_ACCESS_SECRET).digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// A safe, non-reversible hint for display (never expose the token itself).
export function maskToken(plain: string): string {
  if (plain.length <= 8) return '••••';
  return `${plain.slice(0, 5)}…${plain.slice(-4)}`;
}

// SHA-256 of an API key for constant-lookup, non-reversible storage. Used for the
// per-bot machine API key (the AD automation presents the raw key; we match hashes).
export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
