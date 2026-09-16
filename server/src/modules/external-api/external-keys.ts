import crypto from 'crypto';
import { prisma } from '../../config/database';
import { audit } from '../../lib/audit';
import { hashApiKey, maskToken } from '../../config/slackCrypto';

// ─── External ticketing API: key lifecycle ──────────────────────────────────
// V1 entry point is a platform-staff CLI (scripts/external-api-keys.ts); the
// audit trail is written here, not in the CLI, so a future admin UI calls the
// same guarded paths.

export const EXTERNAL_SCOPES = ['tickets.view', 'tickets.write', 'api_keys.manage'] as const;
export type ExternalScope = (typeof EXTERNAL_SCOPES)[number];
export const EXTERNAL_STORES = ['default', 'admin'] as const;
export type ExternalStore = (typeof EXTERNAL_STORES)[number];

export interface CreateKeyInput {
  name: string;
  scopes: ExternalScope[];
  ticketStore: ExternalStore;
  /** Allowed orgs (main-DB customerIds) for the default store. Empty for admin. */
  customerIds?: string[];
  expiresAt?: Date | null;
}

function assertValid(input: CreateKeyInput): void {
  if (!input.name.trim()) throw Object.assign(new Error('name is required'), { status: 400, code: 'VALIDATION_ERROR' });
  if (input.scopes.length === 0) throw Object.assign(new Error('at least one scope required: ' + EXTERNAL_SCOPES.join(', ')), { status: 400, code: 'VALIDATION_ERROR' });
  for (const s of input.scopes) if (!(EXTERNAL_SCOPES as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`unknown scope '${s}'`), { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!(EXTERNAL_STORES as readonly string[]).includes(input.ticketStore)) {
    throw Object.assign(new Error(`ticketStore must be one of: ${EXTERNAL_STORES.join(', ')}`), { status: 400, code: 'VALIDATION_ERROR' });
  }
  // The default store is shared across orgs, so a key must name the orgs it may
  // act for; the admin store is platform-internal and needs no org axis. This
  // is the cross-tenant guard — skip it and one key can read every customer's
  // tickets.
  if (input.ticketStore === 'default' && (input.customerIds ?? []).length === 0) {
    throw Object.assign(new Error('default-store keys must list at least one allowed customerId'), { status: 400, code: 'VALIDATION_ERROR' });
  }
}

export interface IssuedKey {
  id: string;
  clientId: string;
  /** Shown exactly once; stored only as a SHA-256 hash. */
  secret: string;
  secretHint: string;
  scopes: ExternalScope[];
  ticketStore: ExternalStore;
  customerIds: string[];
}

/**
 * Issue a machine credential. `actor` is the platform staff member (or an
 * explicit audit identity); for machine-driven issuance pass the creating
 * user's panel identity.
 */
export async function createKey(input: CreateKeyInput, actor: { userId: string; customerId: string }): Promise<IssuedKey> {
  assertValid(input);
  const clientId = `ext_ck_${crypto.randomBytes(16).toString('hex')}`;
  const secret = `ext_sk_${crypto.randomBytes(32).toString('base64url')}`;
  const secretHint = maskToken(secret);
  const { id } = await prisma.externalApiKey.create({
    data: {
      name: input.name.trim(),
      clientId,
      secretHash: hashApiKey(secret),
      secretHint,
      scopes: [...input.scopes],
      ticketStore: input.ticketStore,
      customerIds: input.customerIds ?? [],
      expiresAt: input.expiresAt ?? null,
      createdById: actor.userId,
    },
    select: { id: true },
  });
  await audit({
    action: 'EXTERNAL_KEY_CREATED',
    performedById: actor.userId,
    targetId: id,
    customerId: actor.customerId,
    metadata: { name: input.name, clientId, secretHint, scopes: input.scopes, ticketStore: input.ticketStore, customerCount: (input.customerIds ?? []).length },
  });
  return { id, clientId, secret, secretHint, scopes: input.scopes, ticketStore: input.ticketStore, customerIds: input.customerIds ?? [] };
}

export async function revokeKey(clientId: string, actor: { userId: string; customerId: string }): Promise<void> {
  const key = await prisma.externalApiKey.findUnique({ where: { clientId }, select: { id: true, name: true } });
  if (!key) throw Object.assign(new Error('Key not found'), { status: 404, code: 'NOT_FOUND' });
  await prisma.externalApiKey.update({ where: { id: key.id }, data: { enabled: false } });
  await audit({
    action: 'EXTERNAL_KEY_REVOKED',
    performedById: actor.userId,
    targetId: key.id,
    customerId: actor.customerId,
    metadata: { name: key.name, clientId },
  });
}

export interface KeyDTO {
  id: string;
  name: string;
  clientId: string;
  secretHint: string;
  scopes: string[];
  ticketStore: string;
  customerIds: string[];
  enabled: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  webhookCount: number;
}

export async function listKeys(): Promise<KeyDTO[]> {
  const rows = await prisma.externalApiKey.findMany({
    include: { _count: { select: { webhooks: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((k) => ({
    id: k.id,
    name: k.name,
    clientId: k.clientId,
    secretHint: k.secretHint,
    scopes: k.scopes as string[],
    ticketStore: k.ticketStore,
    customerIds: k.customerIds as string[],
    enabled: k.enabled,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
    webhookCount: k._count.webhooks,
  }));
}

/** Constant-time comparison for the token endpoint. */
export function verifySecret(key: { secretHash: string }, secret: string): boolean {
  const provided = hashApiKey(secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(key.secretHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}