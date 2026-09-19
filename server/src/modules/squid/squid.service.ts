import crypto from 'crypto';
import express from 'express';
import { prisma } from '../../config/database';
import type { Prisma } from '@prisma/client';
import { encryptSecret, decryptSecret, hashApiKey, maskToken } from '../../config/slackCrypto';
import { audit } from '../../lib/audit';
import { renderProxyConfig, classifyEntry, validateSource, validatePortSpec, validBranchName } from './aclEngine';
import { signBundle, signingPublicKeyPem } from './bundleSigning';
import { scanDependencies } from './depFinder';
import { notify } from '../notifications/notifications.service';
import { createTicket as createTicketingTicket } from '../ticketing/ticketing.service';
import { getTicketDb, runWithTicketDb } from '../../config/ticketDatabase';
import type {
  CreateProxyInput, UpdateProxyInput, ListProxiesInput,
  CreateBranchInput, UpdateBranchInput, SetBranchListsInput,
  SetPortsInput, SetFullAccessInput, AgentResultInput,
  TelemetryIngestInput, ActivityQueryInput, DependencyScanInput,
} from './squid.schema';

// ─── Squid proxy control-plane ───────────────────────────────────────────────
// Org-facing calls rely on the tenant Prisma extension (customerId injected) for
// isolation; staff calls cross tenants via customerContext.exit. The `locked`
// guard is the ONE place that enforces read-only — every mutation routes through
// assertUnlocked().

export const KEY_PREFIX = 'pk_';

// SSE client tracking for real-time change request updates
const changeRequestClients = new Map<string, Set<express.Response>>();

function err(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Get the set of SSE clients for a proxy */
export function getChangeRequestClients(proxyId: string): Set<express.Response> {
  let clients = changeRequestClients.get(proxyId);
  if (!clients) {
    clients = new Set();
    changeRequestClients.set(proxyId, clients);
  }
  return clients;
}

/** Broadcast a change request update to all connected SSE clients */
export function broadcastChangeRequestUpdate(proxyId: string, changeRequest: {
  id: string;
  status: string;
  action: string;
  summary: string;
  ticketId?: string | null;
  ticketUrl?: string | null;
  appliedSeq?: number | null;
  error?: string | null;
  updatedAt: Date;
}) {
  const clients = changeRequestClients.get(proxyId);
  if (!clients || clients.size === 0) return;

  const data = JSON.stringify({ changeRequest });
  const message = `event: change-request-update\ndata: ${data}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch {
      // Client disconnected, remove it
      clients.delete(client);
    }
  }
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

/**
 * Verify a pasted registration token against the proxy's stored key. Lets the
 * org admin confirm the token handed over by the platform admin (or a team
 * member) is the actual current key — no one-time-display dependency. Read-only:
 * no control-plane state changes, so the lock guard does not apply.
 */
export async function verifyRegistrationToken(proxyId: string, actorId: string, customerId: string, token: string): Promise<{ valid: boolean; hint: string | null }> {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: { regKeyEncrypted: true, registrationHint: true } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  let expected: string;
  try { expected = proxy.regKeyEncrypted ? decryptSecret(proxy.regKeyEncrypted) : ''; } catch { expected = ''; }
  const valid = expected.length > 0 && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  await audit({
    action: valid ? 'SQUID_TOKEN_VERIFIED' : 'SQUID_TOKEN_VERIFY_FAILED',
    performedById: actorId, customerId, targetId: proxyId,
    metadata: { hint: valid ? proxy.registrationHint : undefined },
  });
  return { valid, hint: valid ? proxy.registrationHint : null };
}

/** Link an external API key to a proxy for ticketing integration. */
export async function linkExternalApiKey(proxyId: string, actorId: string, customerId: string, externalApiKeyId: string) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, include: { customerService: { select: { endDate: true } } } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  assertUnlocked(proxy);
  
  const extKey = await prisma.externalApiKey.findUnique({ where: { id: externalApiKeyId } });
  if (!extKey) throw err(404, 'NOT_FOUND', 'External API key not found');
  if (!extKey.enabled) throw err(400, 'KEY_DISABLED', 'External API key is disabled');
  
  // Verify the key has the required scopes for ticketing
  const scopes = (extKey.scopes as string[]) ?? [];
  if (!scopes.includes('tickets.write')) {
    throw err(400, 'INVALID_SCOPES', 'External API key must have tickets.write scope');
  }
  
  await prisma.squidProxy.update({
    where: { id: proxyId },
    data: { externalApiKeyId },
  });
  
  await audit({
    action: 'SQUID_EXTERNAL_API_KEY_LINKED',
    performedById: actorId, customerId, targetId: proxyId,
    metadata: { externalApiKeyId, clientId: extKey.clientId },
  });
  
  return { ok: true };
}

/** Unlink the external API key from a proxy. */
export async function unlinkExternalApiKey(proxyId: string, actorId: string, customerId: string) {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, include: { customerService: { select: { endDate: true } } } });
  if (!proxy) throw err(404, 'NOT_FOUND', 'Proxy not found');
  assertUnlocked(proxy);
  
  await prisma.squidProxy.update({
    where: { id: proxyId },
    data: { externalApiKeyId: null },
  });
  
  await audit({
    action: 'SQUID_EXTERNAL_API_KEY_UNLINKED',
    performedById: actorId, customerId, targetId: proxyId,
    metadata: { previousExternalApiKeyId: proxy.externalApiKeyId },
  });
  
  return { ok: true };
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
  // Latest snapshot per proxy for the dashboard's Slack-bot chip. First match per
  // proxyId wins (rows are desc by observedAt). ponytail: take-cap discards the
  // oldest snapshots only; a very hot proxy could crowd another's latest out of
  // the 2000-row window — pull per-proxy separately if fleets get large.
  const snaps = proxies.length ? await prisma.squidTelemetry.findMany({
    where: { proxyId: { in: proxies.map((p) => p.id) } },
    orderBy: { observedAt: 'desc' as const },
    select: { proxyId: true, slackBot: true },
    take: 2000,
  }) : [];
  const latestBot = new Map<string, unknown>();
  for (const s of snaps) if (!latestBot.has(s.proxyId)) latestBot.set(s.proxyId, s.slackBot as unknown);
  const aug = proxies.map((p) => ({ ...p, slackBot: (latestBot.get(p.id) ?? null) as { table?: string; state?: string; lastError?: string } | null }));
  return { proxies: aug, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
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
async function createChangeRequest(input: {
  proxyId: string; customerId: string; actorId: string | null;
  source?: 'WEB' | 'SLACK' | 'API'; action: string; summary: string; details?: Record<string, unknown>;
  createTicket?: boolean;
  bypassApproval?: boolean;
}) {
  const status = input.bypassApproval ? 'APPROVED' : 'PENDING_APPROVAL';
  const changeRequest = await prisma.squidChangeRequest.create({
    data: {
      proxyId: input.proxyId, customerId: input.customerId,
      actorId: input.actorId ?? null, source: input.source ?? 'WEB',
      action: input.action, summary: input.summary, details: input.details ?? {},
      status,
    },
  });

  // Create external ticket for approval workflow (unless bypassed)
  if (input.createTicket !== false && !input.bypassApproval) {
    try {
      await createSquidApprovalTicket(changeRequest.id, input.proxyId, input.customerId, input.action, input.summary, input.details);
    } catch (e) {
      // Ticket creation failed — log but don't block the change request
      console.error('Failed to create approval ticket:', e);
    }
  }

  // If bypassed, auto-apply immediately
  if (input.bypassApproval) {
    applyChangeRequest(changeRequest.id, input.actorId || 'system').catch(async (e) => {
      await prisma.squidChangeRequest.update({
        where: { id: changeRequest.id },
        data: { status: 'FAILED', error: e.message },
      });
    });
  }

  return changeRequest;
}

/** Create an external ticket for squid config approval. */
async function createSquidApprovalTicket(
  changeRequestId: string,
  proxyId: string,
  customerId: string,
  action: string,
  summary: string,
  details?: Record<string, unknown>
) {
  // Get a project for squid tickets (create default if needed)
  const project = await getOrCreateSquidProject();
  
  // Get or create a system user for squid bot
  const botUserId = await getOrCreateSquidBotUser();
  
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: { name: true } });
  const proxyName = proxy?.name || proxyId;

  const ticketInput = {
    title: `Squid Config: ${action} on ${proxyName}`,
    description: `${summary}\n\nChange Request ID: ${changeRequestId}\nAction: ${action}\nDetails: ${JSON.stringify(details, null, 2)}`,
    type: 'task' as const,
    priority: 'medium' as const,
    status: 'todo' as const,
    projectId: project.id,
    assigneeId: botUserId,
    labels: ['squid-proxy', 'config-change', `proxy-${proxyId}`, 'pending:approval'],
    orgCustomerId: customerId,
  };

  // Run in default ticket store scope
  const dto = await runWithTicketDb('default', async () => {
    return createTicketingTicket(botUserId, ticketInput, customerId, 'ADMINISTRATOR');
  });

  // Update change request with ticket info
  await prisma.squidChangeRequest.update({
    where: { id: changeRequestId },
    data: {
      ticketId: dto.id,
      ticketUrl: `/tickets/${dto.id}`,
    },
  });

  return dto;
}

/** Get or create a project for squid tickets. */
async function getOrCreateSquidProject() {
  // Use the ticketing database client for Project model
  const ticketingPrisma = getTicketDb() as any;
  let project = await ticketingPrisma.project.findFirst({ where: { key: 'squid-config' } });
  if (!project) {
    project = await ticketingPrisma.project.create({
      data: {
        key: 'squid-config',
        name: 'Squid Proxy Configuration',
        description: 'Auto-generated project for squid proxy config change approvals',
        settings: {},
      },
    });
  }
  return project;
}

/** Get or create a system user for squid bot. */
async function getOrCreateSquidBotUser() {
  const ticketingPrisma = getTicketDb() as any;
  let user = await ticketingPrisma.users.findFirst({ where: { email: 'squid-bot@banihal.local' } });
  if (!user) {
    user = await ticketingPrisma.users.create({
      data: {
        email: 'squid-bot@banihal.local',
        name: 'Squid Proxy Bot',
        role: 'admin',
        avatarUrl: null,
      },
    });
  }
  return user.id;
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

/** Apply a previously approved change request. Called from ticket approval webhook. */
export async function applyChangeRequest(changeRequestId: string, approverId: string) {
  const cr = await prisma.squidChangeRequest.findUnique({ where: { id: changeRequestId } });
  if (!cr) throw err(404, 'NOT_FOUND', 'Change request not found');
  if (cr.status !== 'APPROVED') throw err(409, 'INVALID_STATUS', `Change request is ${cr.status}, not APPROVED`);

  const proxy = await loadProxy(cr.proxyId);
  assertUnlocked(proxy);

  const details = cr.details as Record<string, unknown>;
  let result: unknown;

  switch (cr.action) {
    case 'CREATE_BRANCH':
      result = await doCreateBranch(cr.proxyId, approverId, cr.customerId, details as CreateBranchInput);
      break;
    case 'UPDATE_BRANCH':
      result = await doUpdateBranch(cr.proxyId, details.branchId as string, approverId, cr.customerId, details as UpdateBranchInput);
      break;
    case 'DELETE_BRANCH':
      result = await doDeleteBranch(cr.proxyId, details.branchId as string, approverId, cr.customerId);
      break;
    case 'SET_LISTS':
      result = await doSetBranchLists(cr.proxyId, details.branchId as string, approverId, cr.customerId, details as SetBranchListsInput);
      break;
    case 'SET_PORTS':
      result = await doSetPorts(cr.proxyId, approverId, cr.customerId, details as SetPortsInput);
      break;
    case 'SET_FULL_ACCESS':
      result = await doSetFullAccess(cr.proxyId, approverId, cr.customerId, details as SetFullAccessInput);
      break;
    default:
      throw err(400, 'UNKNOWN_ACTION', `Unknown action: ${cr.action}`);
  }

  await prisma.squidChangeRequest.update({
    where: { id: changeRequestId },
    data: { status: 'APPLIED', appliedSeq: proxy.revision },
  });

  // Broadcast the update to SSE clients
  const updatedCr = await prisma.squidChangeRequest.findUnique({ where: { id: changeRequestId } });
  if (updatedCr) {
    broadcastChangeRequestUpdate(cr.proxyId, {
      id: updatedCr.id,
      status: updatedCr.status,
      action: updatedCr.action,
      summary: updatedCr.summary,
      ticketId: updatedCr.ticketId,
      ticketUrl: updatedCr.ticketUrl,
      appliedSeq: updatedCr.appliedSeq,
      error: updatedCr.error,
      updatedAt: updatedCr.updatedAt,
    });
  }

  await audit({
    action: 'SQUID_CHANGE_APPLIED', performedById: approverId, customerId: cr.customerId, targetId: changeRequestId,
    metadata: { action: cr.action, proxyId: cr.proxyId, revision: proxy.revision },
  });

  return { ok: true, revision: proxy.revision, result };
}

/** Internal: actually create branch (called from applyChangeRequest) */
async function doCreateBranch(proxyId: string, actorId: string, customerId: string, input: CreateBranchInput) {
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
  return branch;
}

/** Internal: actually update branch */
async function doUpdateBranch(proxyId: string, branchId: string, actorId: string, customerId: string, input: UpdateBranchInput) {
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
  return updated;
}

/** Internal: actually delete branch */
async function doDeleteBranch(proxyId: string, branchId: string, actorId: string, customerId: string) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  const branch = await prisma.squidBranch.findUnique({ where: { id: branchId } });
  if (!branch || branch.proxyId !== proxyId) throw err(404, 'NOT_FOUND', 'Branch not found');
  await prisma.squidBranch.delete({ where: { id: branchId } });
  await bumpRevision(proxyId);
  await audit({ action: 'SQUID_BRANCH_DELETED', performedById: actorId, customerId, targetId: branchId, metadata: { proxyId, branch: branch.name } });
  return { ok: true };
}

/** Internal: actually set branch lists */
async function doSetBranchLists(proxyId: string, branchId: string, actorId: string, customerId: string, input: SetBranchListsInput) {
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
  return { ok: true };
}

/** Internal: actually set ports */
async function doSetPorts(proxyId: string, actorId: string, customerId: string, input: SetPortsInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  assertValidPorts(input);
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { safePorts: input.safePorts, sslPorts: input.sslPorts } });
  await bumpRevision(proxyId);
  await audit({ action: 'SQUID_NETWORK_UPDATED', performedById: actorId, customerId, targetId: proxyId, metadata: { ports: input } });
  return { ok: true };
}

/** Internal: actually set full access */
async function doSetFullAccess(proxyId: string, actorId: string, customerId: string, input: SetFullAccessInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  input.fullAccess.forEach((f) => validateSource(f.src));
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { fullAccess: input.fullAccess } });
  await bumpRevision(proxyId);
  await audit({ action: 'SQUID_NETWORK_UPDATED', performedById: actorId, customerId, targetId: proxyId, metadata: { fullAccessCount: input.fullAccess.length } });
  return { ok: true };
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

  const cr = await createChangeRequest({
    proxyId, customerId, actorId,
    source: 'WEB', action: 'CREATE_BRANCH',
    summary: `Branch “${input.name}” created (${input.mode})`,
    details: { branch: input.name, ...input },
    createTicket: true,
    bypassApproval: input.bypassApproval,
  });

  return { changeRequestId: cr.id, status: cr.status, ticketId: cr.ticketId, ticketUrl: cr.ticketUrl };
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

  const cr = await createChangeRequest({
    proxyId, customerId, actorId,
    source: 'WEB', action: 'UPDATE_BRANCH',
    summary: `Branch “${input.name ?? branch.name}” updated`,
    details: { branchId, changes: input },
    createTicket: true,
    bypassApproval: input.bypassApproval,
  });

  return { changeRequestId: cr.id, status: cr.status, ticketId: cr.ticketId, ticketUrl: cr.ticketUrl };
}

export async function deleteBranch(proxyId: string, branchId: string, actorId: string, customerId: string) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  const branch = await prisma.squidBranch.findUnique({ where: { id: branchId } });
  if (!branch || branch.proxyId !== proxyId) throw err(404, 'NOT_FOUND', 'Branch not found');

  const cr = await createChangeRequest({
    proxyId, customerId, actorId,
    source: 'WEB', action: 'DELETE_BRANCH',
    summary: `Branch “${branch.name}” deleted`,
    details: { branchId },
    createTicket: true,
  });

  return { changeRequestId: cr.id, status: cr.status, ticketId: cr.ticketId, ticketUrl: cr.ticketUrl };
}

export async function setBranchLists(proxyId: string, branchId: string, actorId: string, customerId: string, input: SetBranchListsInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  const branch = await prisma.squidBranch.findUnique({ where: { id: branchId } });
  if (!branch || branch.proxyId !== proxyId) throw err(404, 'NOT_FOUND', 'Branch not found');
  assertValidLists(input);

  const cr = await createChangeRequest({
    proxyId, customerId, actorId,
    source: 'WEB', action: 'SET_LISTS',
    summary: `Lists updated on branch “${branch.name}” (${input.sources.length} sources, ${input.whitelist.length} whitelist, ${input.blacklist.length} blacklist)`,
    details: { branchId, sourceCount: input.sources.length, whitelistCount: input.whitelist.length, blacklistCount: input.blacklist.length, ...input },
    createTicket: true,
    bypassApproval: input.bypassApproval,
  });

  return { changeRequestId: cr.id, status: cr.status, ticketId: cr.ticketId, ticketUrl: cr.ticketUrl };
}

export async function setPorts(proxyId: string, actorId: string, customerId: string, input: SetPortsInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  assertValidPorts(input);

  const cr = await createChangeRequest({
    proxyId, customerId, actorId,
    source: 'WEB', action: 'SET_PORTS',
    summary: `Ports updated (${input.safePorts.length} safe, ${input.sslPorts.length} ssl)`,
    details: { ports: input },
    createTicket: true,
    bypassApproval: input.bypassApproval,
  });

  return { changeRequestId: cr.id, status: cr.status, ticketId: cr.ticketId, ticketUrl: cr.ticketUrl };
}

export async function setFullAccess(proxyId: string, actorId: string, customerId: string, input: SetFullAccessInput) {
  const proxy = await loadProxy(proxyId);
  assertUnlocked(proxy);
  input.fullAccess.forEach((f) => validateSource(f.src));

  const cr = await createChangeRequest({
    proxyId, customerId, actorId,
    source: 'WEB', action: 'SET_FULL_ACCESS',
    summary: `Full-access list updated (${input.fullAccess.length} entries)`,
    details: { fullAccessCount: input.fullAccess.length, fullAccess: input.fullAccess },
    createTicket: true,
    bypassApproval: input.bypassApproval,
  });

  return { changeRequestId: cr.id, status: cr.status, ticketId: cr.ticketId, ticketUrl: cr.ticketUrl };
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

  // Resolve approved change requests that match this applied sequence
  if (input.ok) {
    const appliedSeq = Math.max(proxy.appliedSeq, input.seq);
    const pendingCr = await prisma.squidChangeRequest.findMany({
      where: {
        proxyId,
        status: 'APPROVED',
        appliedSeq: null,
      },
    });

    for (const cr of pendingCr) {
      await prisma.squidChangeRequest.update({
        where: { id: cr.id },
        data: { status: 'APPLIED', appliedSeq },
      });
      await audit({
        action: 'SQUID_CHANGE_APPLIED', performedById: actorId, customerId, targetId: cr.id,
        metadata: { action: cr.action, proxyId, revision: appliedSeq, agentSeq: input.seq },
      });
    }
  }

  if (!input.ok && proxy.status !== 'ERROR' && proxy.status !== 'DISABLED') {
    await prisma.squidProxy.update({ where: { id: proxyId }, data: { status: 'ERROR' } });
    await notifyAdminsOfProxy(customerId, `Proxy “${proxy.name}” could not apply config (seq ${input.seq}).`);
  }
  return { ok: true };
}

export { decryptSecret };

// ─── Telemetry (agent → platform) ────────────────────────────────────────────
const TTL_TELEMETRY_MS = 7 * 24 * 3600e3;   // snapshots kept 7 days → 7-day reports
const TTL_LOGS_MS = 48 * 3600e3;            // live log lines kept 48h → bounded table
const SESSION_WINDOW_MS = 10 * 60e3;        // "active session" = seen in last 10 min

/** Agent pushes one telemetry snapshot per report window (no audit — too noisy). */
export async function ingestTelemetry(proxyId: string, customerId: string, input: TelemetryIngestInput) {
  const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();

  if (input.logLines.length) {
    await prisma.squidLogEntry.createMany({
      data: input.logLines.map((l) => ({
        proxyId, customerId,
        observedAt: l.ts ? new Date(l.ts * 1000) : observedAt,
        clientIp: l.ip, method: l.method, action: l.action, url: l.url,
      })),
    });
  }
  if (input.confSnapshot) {
    // Read-only host-config mirror for the org/platform admin view — upserted
    // so the latest reported snapshot is always one row per proxy.
    await prisma.squidHostConfig.upsert({
      where: { proxyId },
      create: {
        proxyId, customerId,
        hash: input.confSnapshot.hash,
        capturedAt: new Date(input.confSnapshot.capturedAt),
        files: input.confSnapshot.files,
      },
      update: {
        hash: input.confSnapshot.hash,
        capturedAt: new Date(input.confSnapshot.capturedAt),
        files: input.confSnapshot.files,
      },
    });
  }
  await prisma.squidTelemetry.create({
    data: {
      proxyId, customerId, observedAt, seq: input.seq,
      squidVersion: input.squidVersion ?? null,
      uptimeSeconds: input.uptimeSeconds ?? null,
      cpuPercent: input.cpuPercent ?? null,
      memPercent: input.memPercent ?? null,
      diskPercent: input.diskPercent ?? null,
      sessions: input.sessions,
      counters: input.counters,
      slackBot: input.slackBot ?? undefined,
    },
  });
  // Bounded retention — prune on ingest keeps both tables small for a fleet.
  await prisma.squidTelemetry.deleteMany({ where: { proxyId, observedAt: { lt: new Date(Date.now() - TTL_TELEMETRY_MS) } } });
  await prisma.squidLogEntry.deleteMany({ where: { proxyId, observedAt: { lt: new Date(Date.now() - TTL_LOGS_MS) } } });
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return { ok: true };
}

/** Org dashboard: latest snapshot + last-hour traffic deltas + active sessions. */
export async function getTelemetrySummary(proxyId: string) {
  await loadProxy(proxyId);
  const now = Date.now();
  const hourAgo = new Date(now - 3600e3);

  const latest = await prisma.squidTelemetry.findFirst({ where: { proxyId }, orderBy: { observedAt: 'desc' } });
  const inWindow = await prisma.squidTelemetry.findMany({
    where: { proxyId, observedAt: { gte: hourAgo } },
    orderBy: { observedAt: 'asc' as const },
  });
  const baseline = inWindow[0] ?? latest;

  const counter = (json: unknown, key: 'requests' | 'denied' | 'bytes' | 'clients') =>
    Number((json as Record<string, unknown>)?.[key] ?? 0);

  const hour = latest && baseline
    ? {
        requests: Math.max(0, counter(latest.counters, 'requests') - counter(baseline.counters, 'requests')),
        denied: Math.max(0, counter(latest.counters, 'denied') - counter(baseline.counters, 'denied')),
        bytes: Math.max(0, counter(latest.counters, 'bytes') - counter(baseline.counters, 'bytes')),
        clients: Math.max(0, counter(latest.counters, 'clients') - counter(baseline.counters, 'clients')),
      }
    : { requests: 0, denied: 0, bytes: 0, clients: 0 };

  const sessions = await prisma.squidLogEntry.findMany({
    where: { proxyId, observedAt: { gte: new Date(now - SESSION_WINDOW_MS) } },
    orderBy: { observedAt: 'desc' as const },
    distinct: ['clientIp'],
    select: { clientIp: true, observedAt: true },
    take: 5000,
  });

  return {
    latest: latest ? {
      observedAt: latest.observedAt.toISOString(), seq: latest.seq,
      squidVersion: latest.squidVersion, uptimeSeconds: latest.uptimeSeconds,
      cpuPercent: latest.cpuPercent, memPercent: latest.memPercent, diskPercent: latest.diskPercent,
      sessions: latest.sessions,
      slackBot: latest.slackBot as { table?: string; state?: string; lastError?: string } | null,
    } : null,
    hour,
    sessions: sessions.map((s) => ({ clientIp: s.clientIp, lastSeenAt: s.observedAt.toISOString() })),
  };
}

/** Read-only view of the SQUID config actually applied on the bot host. */
export async function getHostConfig(proxyId: string) {
  await loadProxy(proxyId);
  const cfg = await prisma.squidHostConfig.findUnique({ where: { proxyId } });
  if (!cfg) throw err(404, 'NOT_FOUND', 'No host config reported yet — the agent snapshots it once telemetry is up.');
  return {
    hash: cfg.hash,
    capturedAt: cfg.capturedAt.toISOString(),
    files: cfg.files as Array<{ path: string; content: string }>,
  };
}

/** Live Activity feed from the agent's recent log lines. */
export async function listActivity(proxyId: string, q: ActivityQueryInput) {
  await loadProxy(proxyId);
  const denied = q.denied === undefined || q.denied === '' ? undefined : q.denied === 'true';
  const where: Prisma.SquidLogEntryWhereInput = {
    proxyId,
    action: denied === undefined ? undefined : denied ? 'denied' : 'allowed',
    clientIp: q.clientIp || undefined,
    url: q.q ? { contains: q.q, mode: 'insensitive' } : undefined,
    observedAt: q.before ? { lt: new Date(q.before) } : undefined,
  };
  const rows = await prisma.squidLogEntry.findMany({ where, orderBy: { observedAt: 'desc' as const }, take: q.limit });
  return {
    activity: rows.map((r) => ({
      observedAt: r.observedAt.toISOString(), clientIp: r.clientIp,
      method: r.method, action: r.action, url: r.url,
    })),
  };
}

/** 7-day usage report as CSV rows — derived from the bounded telemetry snapshots. */
export async function reportCsv(proxyId: string, days: number) {
  await loadProxy(proxyId);
  const rows = await prisma.squidTelemetry.findMany({
    where: { proxyId, observedAt: { gte: new Date(Date.now() - days * 24 * 3600e3) } },
    orderBy: { observedAt: 'asc' as const },
    select: { observedAt: true, counters: true, sessions: true },
  });
  const counter = (json: unknown, key: string) => Number((json as Record<string, unknown>)?.[key] ?? 0);

  // Bucket by UTC day; per-day deltas between that day's first and last snapshot.
  const daily = new Map<string, { start: (typeof rows)[number] | null; end: (typeof rows)[number] | null; peers: Set<string> }>();
  for (const r of rows) {
    const day = r.observedAt.toISOString().slice(0, 10);
    const d = daily.get(day) ?? { start: null as (typeof rows)[number] | null, end: null as (typeof rows)[number] | null, peers: new Set<string>() };
    if (!d.start) d.start = r;
    d.end = r;
    for (const ip of (Array.isArray(r.sessions) ? r.sessions : []) as string[]) d.peers.add(ip);
    daily.set(day, d);
  }

  const out = ['day,requests,denied,bytes,active_clients'];
  for (const [day, d] of [...daily.entries()].sort()) {
    const requests = d.start && d.end ? Math.max(0, counter(d.end.counters, 'requests') - counter(d.start.counters, 'requests')) : 0;
    const denied = d.start && d.end ? Math.max(0, counter(d.end.counters, 'denied') - counter(d.start.counters, 'denied')) : 0;
    const bytes = d.start && d.end ? Math.max(0, counter(d.end.counters, 'bytes') - counter(d.start.counters, 'bytes')) : 0;
    out.push([day, requests, denied, bytes, d.peers.size].join(','));
  }
  return out.join('\n');
}

/** Dependency finder (static HTML, SSRF-guarded). Human ticks → then whitelist. */
export async function dependencyScan(proxyId: string, actorId: string, customerId: string, input: DependencyScanInput) {
  await loadProxy(proxyId);
  const result = await scanDependencies(input.url);
  await audit({
    action: 'SQUID_DEPENDENCY_SCAN', performedById: actorId, customerId, targetId: proxyId,
    metadata: { url: input.url, branchId: input.branchId ?? null, found: result.dependencies.length, excluded: result.excluded.length },
  });
  return result;
}