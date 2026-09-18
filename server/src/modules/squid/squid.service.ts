import crypto from 'crypto';
import { prisma } from '../../config/database';
import type { Prisma } from '@prisma/client';
import { encryptSecret, decryptSecret, hashApiKey, maskToken } from '../../config/slackCrypto';
import { audit } from '../../lib/audit';
import { renderProxyConfig, classifyEntry, validateSource, validatePortSpec, validBranchName } from './aclEngine';
import { signBundle, signingPublicKeyPem } from './bundleSigning';
import { notify } from '../notifications/notifications.service';
import type {
  CreateProxyInput, UpdateProxyInput, ListProxiesInput,
  CreateBranchInput, UpdateBranchInput, SetBranchListsInput,
  SetPortsInput, SetFullAccessInput, AgentResultInput,
} from './squid.schema';

// ─── Squid proxy control-plane ───────────────────────────────────────────────
// Org-facing calls rely on the tenant Prisma extension (customerId injected) for
// isolation; staff calls cross tenants via customerContext.exit. The `locked`
// guard is the ONE place that enforces read-only — every mutation routes through
// assertUnlocked().

export const KEY_PREFIX = 'pk_';

function err(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

// The `locked` guard is the ONE place that enforces read-only enforcement: every
// mutation routes through assertUnlocked(). Locked means explicitly disabled OR
// the governing subscription expired — checked reactively, no cron needed.
function assertUnlocked(proxy: { locked: boolean; customerService?: { endDate: Date } | null }): void {
  const expired = proxy.customerService && proxy.customerService.endDate.getTime() < Date.now();
  if (proxy.locked || expired) {
    throw err(423, 'SQUID_LOCKED', 'This proxy is locked (disabled or expired subscription) — read-only.');
  }
}

// Validate BEFORE storing so the ACL engine never sees garbage (it fails loud
// anyway; this surfaces a clean 400 with a message on the right field).
function assertValidLists(input: SetBranchListsInput): void {
  for (const e of [...input.whitelist, ...input.blacklist]) classifyEntry(e.value, e.subdomain);
  input.sources.forEach(validateSource);
}

function assertValidPorts(input: SetPortsInput): void {
  [...input.safePorts, ...input.sslPorts].forEach(validatePortSpec);
}

// Loads entries as {value, subdomain} from JSONB.
function entries(json: unknown): Array<{ value: string; subdomain: boolean }> {
  return Array.isArray(json) ? (json as Array<{ value: string; subdomain: boolean }>) : [];
}

// ─── Auth: agent registration key ────────────────────────────────────────────
export function generateRegistrationKey(): { raw: string; hint: string; hash: string; encrypted: string } {
  const raw = `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  return { raw, hint: maskToken(raw), hash: hashApiKey(raw), encrypted: encryptSecret(raw) };
}

/** Mint a fresh key pair of columns for a proxy (rotation or first provision). */
export async function rotateAgentKey(proxyId: string, actorId: string, customerId: string): Promise<{ hint: string; raw: string }> {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, include: { customerService: { select: { endDate: true } } } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  assertUnlocked(proxy);
  const k = generateRegistrationKey();
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { regKeyHash: k.hash, regKeyEncrypted: k.encrypted, registrationHint: k.hint } });
  await audit({ action: 'SQUID_PROXY_KEY_GENERATED', performedById: actorId, customerId, targetId: proxyId, metadata: { hint: k.hint } });
  return { hint: k.hint, raw: k.raw };
}

// ─── Org-facing CRUD ─────────────────────────────────────────────────────────
export async function listProxies(input: ListProxiesInput) {
  const skip = (input.page - 1) * input.limit;
  const [proxies, total] = await Promise.all([
    prisma.squidProxy.findMany({
      skip, take: input.limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, description: true, status: true, lastSeenAt: true, lastError: true,
        revision: true, appliedSeq: true, locked: true, createdAt: true,
        customerService: { select: { id: true, name: true, endDate: true } },
        _count: { select: { branches: true } },
      },
    }),
    prisma.squidProxy.count(),
  ]);
  return { proxies, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

const proxyDetailSelect = {
  id: true, customerId: true, name: true, description: true, transport: true,
  status: true, lastSeenAt: true, lastError: true, revision: true, appliedSeq: true,
  locked: true, registrationHint: true, safePorts: true, sslPorts: true, fullAccess: true,
  customerService: { select: { id: true, name: true, endDate: true } },
  branches: { orderBy: { createdAt: 'asc' as const } },
  createdAt: true, updatedAt: true,
} satisfies Prisma.SquidProxySelect;

export async function getProxy(proxyId: string) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: proxyDetailSelect });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  return {
    ...proxy,
    registrationHint: proxy.registrationHint,
    branches: proxy.branches.map((b) => ({
      id: b.id, name: b.name, description: b.description, mode: b.mode,
      sources: b.sources, whitelist: entries(b.whitelist), blacklist: entries(b.blacklist),
    })),
  };
}

export async function createProxy(customerId: string, input: CreateProxyInput) {
  const { name, description, transport } = input;
  if (!validBranchName(name)) throw err(400, 'VALIDATION_ERROR', 'Invalid proxy name');
  const existing = await prisma.squidProxy.findFirst({ where: { name } });
  if (existing) throw err(409, 'NAME_TAKEN', 'A proxy with this name already exists');
  // customerId is set explicitly — create is not auto-scoped by the tenant
  // extension (the org controller passes it through req.user.customerId).
  return prisma.squidProxy.create({ data: { customerId, name, description: description ?? null, transport } });
}

export async function updateProxy(proxyId: string, input: UpdateProxyInput) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, include: { customerService: { select: { endDate: true } } } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  assertUnlocked(proxy);
  if (input.name) {
    const clash = await prisma.squidProxy.findFirst({ where: { name: input.name, id: { not: proxyId } } });
    if (clash) throw err(409, 'NAME_TAKEN', 'A proxy with this name already exists');
  }
  return prisma.squidProxy.update({ where: { id: proxyId }, data: input });
}

export async function deleteProxy(proxyId: string, actorId: string, customerId: string) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  if (proxy.customerServiceId) {
    throw err(409, 'SQUID_MANAGED', 'This proxy is provisioned by a purchased service. Remove the service to disable it, then delete.');
  }
  await prisma.squidProxy.delete({ where: { id: proxyId } });
  await audit({ action: 'SQUID_PROXY_DISABLED', performedById: actorId, customerId, targetId: proxyId, metadata: { name: proxy.name, reason: 'deleted' } });
  return { ok: true };
}

// ─── Branches ────────────────────────────────────────────────────────────────
async function loadProxy(proxyId: string) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, include: { branches: true, customerService: { select: { endDate: true } } } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  return proxy;
}

/** Bump revision (orchestrating config change). Returns the bump result. */
async function bumpRevision(proxyId: string) {
  return prisma.squidProxy.update({ where: { id: proxyId }, data: { revision: { increment: 1 } }, select: { id: true } });
}

/** Auto-ticket: record each requested config change so it is attributable,
 *  whether it came from the web dashboard or a Slack/API bot surface. */
async function recordChangeRequest(input: {
  proxyId: string; customerId: string; actorId: string | null;
  source?: 'WEB' | 'SLACK' | 'API'; action: string; summary: string; details?: Record<string, unknown>;
}) {
  await prisma.squidChangeRequest.create({
    data: {
      proxyId: input.proxyId, customerId: input.customerId,
      actorId: input.actorId ?? null, source: input.source ?? 'WEB',
      action: input.action, summary: input.summary, details: input.details ?? {},
    },
  }).catch(() => {});
}

/** Recent change-request records for a proxy (the auto-ticket ledger). */
export async function listChangeRequests(proxyId: string, limit = 100) {
  await loadProxy(proxyId);
  const rows = await prisma.squidChangeRequest.findMany({
    where: { proxyId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return { changeRequests: rows };
}

export async function listBranches(proxyId: string) {
  await loadProxy(proxyId);
  return prisma.squidBranch.findMany({ where: { proxyId }, orderBy: { createdAt: 'asc' } });
}

export async function createBranch(proxyId: string, actorId: string, customerId: string, input: CreateBranchInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  if (!validBranchName(input.name)) throw err(400, 'VALIDATION_ERROR', 'Invalid branch name');
  const clash = await prisma.squidBranch.findUnique({ where: { proxyId_name: { proxyId, name: input.name } } });
  if (clash) throw err(409, 'NAME_TAKEN', 'A branch with this name already exists');
  const branch = await prisma.squidBranch.create({
    data: { proxyId, customerId, name: input.name, description: input.description ?? null, mode: input.mode },
  });
  await bumpRevision(proxyId);
  await audit({ action: 'SQUID_BRANCH_CREATED', performedById: actorId, customerId, targetId: branch.id, metadata: { proxyId, branch: input.name } });
  await recordChangeRequest({ proxyId, customerId, actorId, action: 'CREATE_BRANCH', summary: `Branch “${input.name}” created (${input.mode})`, details: { branchId: branch.id, branch: input.name, mode: input.mode } });
  return branch;
}

export async function updateBranch(proxyId: string, branchId: string, actorId: string, customerId: string, input: UpdateBranchInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  const branch = await prisma.squidBranch.findUnique({ where: { id: branchId } });
  if (!branch || branch.proxyId !== proxyId) throw err(404, 'NOT_FOUND', 'Branch not found');
  if (input.name && input.name !== branch.name) {
    const clash = await prisma.squidBranch.findUnique({ where: { proxyId_name: { proxyId, name: input.name } } });
    if (clash) throw err(409, 'NAME_TAKEN', 'A branch with this name already exists');
  }
  const updated = await prisma.squidBranch.update({ where: { id: branchId }, data: { name: input.name, description: input.description, mode: input.mode } });
  await bumpRevision(proxyId);
  await audit({ action: 'SQUID_BRANCH_UPDATED', performedById: actorId, customerId, targetId: branchId, metadata: { proxyId, changes: input } });
  await recordChangeRequest({ proxyId, customerId, actorId, action: 'UPDATE_BRANCH', summary: `Branch “${input.name ?? branch.name}” updated`, details: { branchId, changes: input } });
  return updated;
}

export async function deleteBranch(proxyId: string, branchId: string, actorId: string, customerId: string) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  const branch = await prisma.squidBranch.findUnique({ where: { id: branchId } });
  if (!branch || branch.proxyId !== proxyId) throw err(404, 'NOT_FOUND', 'Branch not found');
  await prisma.squidBranch.delete({ where: { id: branchId } });
  await bumpRevision(proxyId); // revision bumps even though we only DELETE a file
  await audit({ action: 'SQUID_BRANCH_DELETED', performedById: actorId, customerId, targetId: branchId, metadata: { proxyId, branch: branch.name } });
  await recordChangeRequest({ proxyId, customerId, actorId, action: 'DELETE_BRANCH', summary: `Branch “${branch.name}” deleted`, details: { branchId } });
  return { ok: true };
}

export async function setBranchLists(proxyId: string, branchId: string, actorId: string, customerId: string, input: SetBranchListsInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  const branch = await prisma.squidBranch.findUnique({ where: { id: branchId } });
  if (!branch || branch.proxyId !== proxyId) throw err(404, 'NOT_FOUND', 'Branch not found');
  assertValidLists(input);
  await prisma.squidBranch.update({
    where: { id: branchId },
    data: { sources: input.sources, whitelist: input.whitelist, blacklist: input.blacklist },
  });
  await bumpRevision(proxyId);
  await audit({
    action: 'SQUID_LIST_UPDATED', performedById: actorId, customerId, targetId: branchId,
    metadata: { proxyId, branch: branch.name, sourceCount: input.sources.length, whitelistCount: input.whitelist.length, blacklistCount: input.blacklist.length },
  });
  await recordChangeRequest({
    proxyId, customerId, actorId, action: 'SET_LISTS',
    summary: `Lists updated on branch “${branch.name}” (${input.sources.length} sources, ${input.whitelist.length} whitelist, ${input.blacklist.length} blacklist)`,
    details: { branchId, sourceCount: input.sources.length, whitelistCount: input.whitelist.length, blacklistCount: input.blacklist.length },
  });
  return { ok: true };
}

export async function setPorts(proxyId: string, actorId: string, customerId: string, input: SetPortsInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  assertValidPorts(input);
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { safePorts: input.safePorts, sslPorts: input.sslPorts } });
  await bumpRevision(proxyId);
  await audit({ action: 'SQUID_NETWORK_UPDATED', performedById: actorId, customerId, targetId: proxyId, metadata: { ports: input } });
  await recordChangeRequest({ proxyId, customerId, actorId, action: 'SET_PORTS', summary: `Ports updated (${input.safePorts.length} safe, ${input.sslPorts.length} ssl)`, details: { ports: input } });
  return { ok: true };
}

export async function setFullAccess(proxyId: string, actorId: string, customerId: string, input: SetFullAccessInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  input.fullAccess.forEach((f) => validateSource(f.src));
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { fullAccess: input.fullAccess } });
  await bumpRevision(proxyId);
  await audit({ action: 'SQUID_NETWORK_UPDATED', performedById: actorId, customerId, targetId: proxyId, metadata: { fullAccessCount: input.fullAccess.length } });
  await recordChangeRequest({ proxyId, customerId, actorId, action: 'SET_FULL_ACCESS', summary: `Full-access list updated (${input.fullAccess.length} entries)`, details: { fullAccessCount: input.fullAccess.length } });
  return { ok: true };
}

// ─── Render & agent protocol ─────────────────────────────────────────────────
/** The full config a proxy's agent must hold right now (seq = revision). */
export async function renderBundle(proxyId: string) {
  const proxy = await prisma.squidProxy.findUnique({
    where: { id: proxyId }, include: { branches: { orderBy: { createdAt: 'asc' } } },
  });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  const files = renderProxyConfig({
    safePorts: proxy.safePorts as string[],
    sslPorts: proxy.sslPorts as string[],
    fullAccess: proxy.fullAccess as Array<{ src: string; description?: string; until?: string; window?: { days: string[]; from: string; to: string } }>,
  }, proxy.branches.map((b) => ({
    name: b.name, mode: b.mode,
    sources: b.sources as string[],
    whitelist: entries(b.whitelist),
    blacklist: entries(b.blacklist),
  })), proxy.revision);
  return { proxy, bundle: files };
}

export function buildSignedBundle(files: Array<{ path: string; content: string }>, seq: number) {
  return { collection: 'squid-conf', seq, files, signature: signBundle(seq, files) };
}

export const agentBundlePublicKey = () => signingPublicKeyPem();

// ─── Provisioning hook (called by saas-admin on kind=SQUID_PROXY assign) ─────
export async function provisionSquidProxy(customerId: string, customerServiceId: string, name: string, adminUserId: string) {
  const k = generateRegistrationKey();
  const proxy = await prisma.squidProxy.create({
    data: {
      customerId, name: `proxy-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32)}`,
      description: `Provisioned from service “${name}”`,
      status: 'PENDING', customerServiceId,
      regKeyHash: k.hash, regKeyEncrypted: k.encrypted, registrationHint: k.hint,
    },
  });
  await audit({ action: 'SQUID_SERVICE_PROVISIONED', performedById: adminUserId, customerId, targetId: proxy.id, metadata: { serviceId: customerServiceId, proxy: proxy.name, hint: k.hint } });
  return { proxy, key: k.raw, hint: k.hint };
}
export async function disableSquidProxy(proxyId: string, actorId: string, customerId: string, reason: string) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
  if (!proxy) return;
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { status: 'DISABLED', locked: true } });
  await audit({ action: 'SQUID_PROXY_DISABLED', performedById: actorId, customerId, targetId: proxyId, metadata: { proxy: proxy.name, reason } });
  await notifyAdminsOfProxy(customerId, `Proxy “${proxy.name}” disabled (${reason}).`);
}

/** Notify the org's admins about a lifecycle event (provision, disable). */
async function notifyAdminsOfProxy(customerId: string, message: string): Promise<void> {
  const admins = await prisma.user.findMany({ where: { customerId, role: 'ORG_ADMIN' }, select: { id: true } });
  for (const a of admins) {
    await notify({ userId: a.id, customerId, kind: 'squid_proxy', title: message, url: '/squid' }).catch(() => {});
  }
}

// ─── Agent runtime surface ───────────────────────────────────────────────────
export async function agentPoll(proxyId: string) {
  const proxy = await prisma.squidProxy.findUnique({
    where: { id: proxyId },
    include: { customerService: { select: { endDate: true } } },
  });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');

  // Auto-suspend: the agent poll is the enforcement point for expiry AND the
  // explicit lock. A proxy whose subscription has lapsed (or that was disabled)
  // stops receiving its real rules and is pushed a default-deny lock bundle —
  // the host applies it like any other revision, so the network actually closes.
  const now = Date.now();
  const suspended = proxy.locked || (!!proxy.customerService && proxy.customerService.endDate.getTime() < now);
  let revision = proxy.revision;

  // Heartbeat: a successful authenticated poll = the agent is alive. Only a
  // DISABLED proxy stays put (disabled is an explicit operational decision that a
  // poll must never silently override); everything else flips to CONNECTED.
  const nextStatus = proxy.status === 'DISABLED' ? 'DISABLED' : 'CONNECTED';
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { lastSeenAt: new Date(), status: nextStatus } });

  if (suspended && !proxy.locked) {
    // First observation of the lapse: persist the write-guard, raise the lock
    // revision so the agent pulls the deny-all bundle, and tell the org admins.
    await prisma.squidProxy.update({ where: { id: proxyId }, data: { locked: true, revision: { increment: 1 } } });
    revision += 1;
    await audit({
      action: 'SQUID_CONFIG_LOCKED', performedById: null, customerId: proxy.customerId, targetId: proxyId,
      metadata: { reason: proxy.customerService ? 'subscription expired' : 'locked', seq: revision },
    }).catch(() => {});
    await notifyAdminsOfProxy(proxy.customerId, `Proxy “${proxy.name}” auto-suspended (subscription expired) — its config is locked deny-all.`).catch(() => {});
  }

  if (revision <= proxy.appliedSeq) return { pending: null, appliedSeq: proxy.appliedSeq, revision };

  const bundle = suspended
    ? renderProxyConfig({ safePorts: [], sslPorts: [], fullAccess: [] }, [], revision)
    : (await renderBundle(proxyId)).bundle;
  return { pending: buildSignedBundle(bundle.files, revision), appliedSeq: proxy.appliedSeq, revision };
}

/** Agent reports the outcome of applying a rendered revision. */
export async function agentResult(proxyId: string, actorId: string | null, customerId: string, input: AgentResultInput) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  const data: Record<string, unknown> = { lastSeenAt: new Date(), lastError: input.ok ? null : (input.error ?? 'apply failed') };
  if (input.ok) data.appliedSeq = Math.max(proxy.appliedSeq, input.seq); // only forward progress monotonic ack
  await prisma.squidProxy.update({ where: { id: proxyId }, data });
  await audit({ action: 'SQUID_APPLY_RESULT', performedById: actorId, customerId, targetId: proxyId, metadata: { seq: input.seq, ok: input.ok, error: input.ok ? undefined : input.error } });
  if (!input.ok && proxy.status !== 'ERROR' && proxy.status !== 'DISABLED') {
    await prisma.squidProxy.update({ where: { id: proxyId }, data: { status: 'ERROR' } });
    await notifyAdminsOfProxy(customerId, `Proxy “${proxy.name}” could not apply config (seq ${input.seq}).`);
  }
  return { ok: true };
}

export { decryptSecret };