import crypto from 'crypto';
import type { Request } from 'express';
import { prisma } from '../config/database';
import { redis } from './redis';

export const NONCE_RE = /^[a-f0-9]{32,64}$/;
export const MACHINE_WINDOW_MS = 300_000;
export const machineSecurityRequired = () => process.env.MACHINE_SECURITY_ENFORCED === 'true' || process.env.NODE_ENV === 'production';

export function canonicalMachineV2(actor: string, ts: string, nonce: string, method: string, path: string, hash: string): string {
  return ['B2B-MACHINE-V2', actor, ts, nonce, method.toUpperCase(), path, hash].join('\n');
}

export function verifyCertificateBinding(expected: string, received: string): boolean {
  const normal = received.replace(/:/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(normal)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(normal, 'hex'));
}

type NonceStore = { status: string; set: (...args: any[]) => Promise<unknown> };
export async function reserveNonce(actor: string, nonce: string, store: NonceStore | null = redis): Promise<boolean> {
  if (!store || store.status !== 'ready') throw new Error('Replay protection unavailable');
  // A future-dated timestamp may remain valid for twice the accepted clock skew.
  return await store.set(`b2b:machine:nonce:${actor}:${nonce}`, '1', 'PX', 2 * MACHINE_WINDOW_MS + 1, 'NX') === 'OK';
}

export async function machineIdentity(req: Request, actor: string): Promise<{ minVersion: number } | null> {
  const row = await prisma.machineIdentity.findUnique({ where: { id: actor } });
  if (!row && !machineSecurityRequired()) return { minVersion: 1 };
  if (!row?.enabled) return null;
  const remote = req.socket.remoteAddress;
  const trust = req.app.get('trust proxy fn') as ((ip: string, hop: number) => boolean) | undefined;
  if (!remote || !trust?.(remote, 0) || !req.secure || req.get('X-Machine-Verified') !== 'SUCCESS') return null;
  let fingerprint: string;
  try {
    fingerprint = new crypto.X509Certificate(decodeURIComponent(req.get('X-Machine-Certificate') ?? '')).fingerprint256;
  } catch { return null; }
  if (!verifyCertificateBinding(row.certificateSha256, fingerprint)) return null;
  return { minVersion: row.minVersion };
}
