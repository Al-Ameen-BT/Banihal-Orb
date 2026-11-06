import crypto from 'crypto';
import { env } from '../../config/env';

// ─── Agent bundle signing ────────────────────────────────────────────────────
// Bundles are signed with an Ed25519 private key held ONLY by the platform; the
// per-host agent pins the matching public key at bootstrap (`/api/saas-admin/
// squid/bundle-key`). Squid -k parse will refuse a bad conf, and the agent
// refuses an unsigned one, so tampering anywhere in the path is caught before
// squid listens with it. Ed25519 keys are raw 32-byte seeds; pack into a PKCS8
// frame so crypto.createPrivateKey accepts it.
function seed(): Buffer {
  const raw = env.SQUID_SIGNING_PRIVATE_KEY;
  if (env.NODE_ENV === 'production' && !raw) throw new Error('SQUID_SIGNING_PRIVATE_KEY is required in production');
  const hex = raw ?? crypto.createHash('sha256').update(env.SLACK_TOKEN_SECRET ?? env.JWT_ACCESS_SECRET).digest('hex');
  if (!raw && env.NODE_ENV !== 'test') {
    // Deterministic-from-env fallback: fine for a dev box, wrong for prod. The
    // test suite pins its own key explicitly, so this only fires outside tests.
    console.warn('⚠️  SQUID_SIGNING_PRIVATE_KEY unset — bundle key derived from SLACK_TOKEN_SECRET (dev only).');
  }
  return Buffer.from(hex, 'hex');
}

let cachedKey: crypto.KeyObject | null = null;
function signingKey(): crypto.KeyObject {
  if (!cachedKey) cachedKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed()]), format: 'der', type: 'pkcs8' });
  return cachedKey;
}

/** Deterministic canonical form of a bundle → the bytes that get signed. */
export function canonicalBundle(seq: number, files: Array<{ path: string; content: string }>, proxyId?: string): string {
  return JSON.stringify(proxyId ? { protocol: 2, proxyId, seq, files } : { seq, files });
}

export function signBundle(seq: number, files: Array<{ path: string; content: string }>, proxyId?: string): string {
  return crypto.sign(null, Buffer.from(canonicalBundle(seq, files, proxyId), 'utf8'), signingKey()).toString('base64');
}

export function verifyBundle(seq: number, files: Array<{ path: string; content: string }>, signature: string, publicKeyPem: string, proxyId?: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonicalBundle(seq, files, proxyId), 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** DER SPKI of the signing key — the value the agent pins at bootstrap. */
export function signingPublicKeyPem(): string {
  return crypto.createPublicKey(signingKey()).export({ type: 'spki', format: 'pem' }).toString();
}
