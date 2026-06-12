import { env } from '../../config/env';
import { prisma } from '../../config/database';
import type { ServiceRequest } from '@prisma/client';

/**
 * External ticketing provider — mirror + sync.
 *
 * Local `ServiceRequest` rows remain the app's source of truth. When the
 * integration is configured (TICKETING_API_URL set), every create/update is
 * pushed to the external system and the returned reference is stored on the
 * row (`externalId`); sync outcomes land in `externalSyncedAt` / `externalSyncError`.
 *
 * All sync calls are fire-and-forget: an unreachable or failing external API
 * must never break the user-facing ticket flow. Failures are recorded on the
 * row so they're visible and re-tried on the next update of that ticket.
 *
 * ── TODO (fill in when the provider's API spec is supplied) ────────────────
 * The endpoint paths, auth header, payload field names, and the value
 * mappings below are PLACEHOLDERS following common REST conventions. Adjust
 * `authHeaders`, `buildPayload`, `PRIORITY_MAP`, `STATUS_MAP`, the paths in
 * `pushCreate` / `pushUpdate`, and `extractExternalId` to the real API.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export function ticketingEnabled(): boolean {
  return Boolean(env.TICKETING_API_URL);
}

// ─── Value mappings: our enums → provider vocabulary (placeholder values) ────
const PRIORITY_MAP: Record<string, string> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

const STATUS_MAP: Record<string, string> = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
  ESCALATED: 'escalated',
};

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    // TODO: adjust to the provider's auth scheme (e.g. 'X-API-Key', OAuth bearer…)
    ...(env.TICKETING_API_KEY ? { Authorization: `Bearer ${env.TICKETING_API_KEY}` } : {}),
  };
}

// TODO: align field names with the provider's create/update payload.
function buildPayload(ticket: ServiceRequest): Record<string, unknown> {
  return {
    reference: ticket.id,                       // our id, for cross-linking
    subject: ticket.subject,
    description: ticket.description ?? '',
    type: ticket.type,
    priority: PRIORITY_MAP[ticket.priority] ?? 'medium',
    status: STATUS_MAP[ticket.status] ?? 'open',
    service: ticket.service,
    requestedAt: ticket.createdAt.toISOString(),
  };
}

// TODO: adjust to wherever the provider returns its ticket identifier.
function extractExternalId(body: unknown): string | null {
  const b = body as { id?: string | number; ticketId?: string | number; reference?: string } | null;
  const id = b?.id ?? b?.ticketId ?? b?.reference;
  return id !== undefined && id !== null ? String(id) : null;
}

async function callApi(path: string, method: 'POST' | 'PATCH', payload: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.TICKETING_API_URL}${path}`, {
      method,
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ticketing API ${method} ${path} responded ${res.status}`);
    }
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

async function recordSync(ticketId: string, externalId: string | null, error: string | null): Promise<void> {
  await prisma.serviceRequest.update({
    where: { id: ticketId },
    data: {
      ...(externalId ? { externalId } : {}),
      externalSyncedAt: error ? undefined : new Date(),
      externalSyncError: error,
    },
  }).catch(() => {});
}

async function pushCreate(ticket: ServiceRequest): Promise<void> {
  const body = await callApi('/tickets', 'POST', buildPayload(ticket)); // TODO: real create path
  await recordSync(ticket.id, extractExternalId(body), null);
}

async function pushUpdate(ticket: ServiceRequest): Promise<void> {
  if (!ticket.externalId) {
    // Initial create never synced (or failed) — mirror it now instead.
    await pushCreate(ticket);
    return;
  }
  await callApi(`/tickets/${encodeURIComponent(ticket.externalId)}`, 'PATCH', { // TODO: real update path
    status: STATUS_MAP[ticket.status] ?? 'open',
    priority: PRIORITY_MAP[ticket.priority] ?? 'medium',
    assignedTo: ticket.assignedTo,
    ...(ticket.resolvedAt ? { resolvedAt: ticket.resolvedAt.toISOString() } : {}),
  });
  await recordSync(ticket.id, null, null);
}

// ─── Public fire-and-forget hooks (never throw into the caller's flow) ───────

export function syncTicketCreated(ticket: ServiceRequest): void {
  if (!ticketingEnabled()) return;
  void pushCreate(ticket).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : 'Unknown ticketing sync error';
    void recordSync(ticket.id, null, msg);
  });
}

export function syncTicketUpdated(ticket: ServiceRequest): void {
  if (!ticketingEnabled()) return;
  void pushUpdate(ticket).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : 'Unknown ticketing sync error';
    void recordSync(ticket.id, null, msg);
  });
}
