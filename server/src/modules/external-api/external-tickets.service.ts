import { Request } from 'express';
import { getTicketDb } from '../../config/ticketDatabase';
import { audit } from '../../lib/audit';
import * as ticketing from '../ticketing/ticketing.service';
import { listComments as dbListComments, getTicketCore } from '../ticketing/ticketing.client';
import type { TicketDTO } from '../ticketing/ticketing.types';
import type { ExternalCreateTicketInput, ExternalUpdateTicketInput } from './external.schema';
import { runExternalStore, assertTicketInScope, ticketActor, allowedCustomerIds, orgForAudit, resolveTicketOrg } from './external-scope';
import { notifyApprovalForExternalTicket } from '../slack-bots/slackApprovals';
import { emitTicketEvent, emitOrgTicketEvent } from './external-webhooks';

// ─── External resource operations ────────────────────────────────────────────
// Thin wrappers over the existing ticketing service, adding the two things the
// platform UI never needed: per-key store binding (runExternalStore) and the
// default-store org axis (allowedCustomerIds / assertTicketInScope). The DTOs,
// SLA clock and notification plumbing all come from the shared service.

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404, code: 'NOT_FOUND' });

export async function listTickets(req: Request, filters: { status?: string; priority?: string; type?: string; projectId?: string; assigneeId?: string; search?: string }): Promise<TicketDTO[]> {
  return runExternalStore(req, async () => {
    const customerIds = await allowedCustomerIds(req);
    return ticketing.listTickets({
      status: filters.status as TicketDTO['status'] | undefined,
      priority: filters.priority as TicketDTO['priority'] | undefined,
      type: filters.type as TicketDTO['type'] | undefined,
      projectId: filters.projectId,
      assigneeId: filters.assigneeId,
      search: filters.search,
      ...(customerIds === undefined ? {} : { customerIds }),
    });
  });
}

export async function getTicket(req: Request, id: string): Promise<TicketDTO> {
  const dto = await runExternalStore(req, async () => {
    await assertTicketInScope(req, id);
    return ticketing.getTicket(id);
  });
  if (!dto) throw notFound('Ticket');
  return dto;
}

export async function createTicket(req: Request, input: ExternalCreateTicketInput): Promise<TicketDTO> {
  const external = req.external!;
  const store = external.store;
  if (store === 'default') {
    if (!input.orgCustomerId || !external.orgs.includes(input.orgCustomerId)) {
      throw Object.assign(new Error('orgCustomerId must be one of the orgs allowed for this key'), { status: 403, code: 'ORG_NOT_ALLOWED' });
    }
  } else if (input.orgCustomerId) {
    throw Object.assign(new Error('orgCustomerId is only valid on the default store'), { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { orgCustomerId, customerId, ...rest } = input;
  // Every external ticket starts pending approval; the platform UI or Slack
  // interaction handler clears the label on approve/decline.
  const labels = [...(rest.labels ?? []), 'pending:approval'];

  const dto = await runExternalStore(req, async () => {
    const persona = await getTicketDb().users.findUnique({ where: { id: input.assigneeId }, select: { id: true } });
    if (!persona) throw Object.assign(new Error('assigneeId must reference an existing ticket user'), { status: 400, code: 'ASSIGNEE_NOT_FOUND' });
    if (store === 'default') {
      return ticketing.createTicket(input.assigneeId, { ...rest, labels, customerId: undefined }, orgCustomerId);
    }
    return ticketing.createTicket(input.assigneeId, { ...rest, labels, customerId: customerId ?? null }, null);
  });

  const auditCustomerId = await orgForAudit(req, store === 'default' ? orgCustomerId : undefined);
  if (auditCustomerId) {
    await audit({
      action: 'TICKET_CREATED',
      performedById: null,
      targetId: dto.id,
      customerId: auditCustomerId,
      metadata: { ticketNumber: dto.ticketNumber, via: 'external', clientId: external.clientId },
    });
    // Record that approval is requested so the platform UI / Slack can pick it up.
    await audit({
      action: 'TICKET_APPROVAL_REQUESTED',
      performedById: null,
      targetId: dto.id,
      customerId: auditCustomerId,
      metadata: { ticketNumber: dto.ticketNumber, clientId: external.clientId },
    });
  }

  // Slack delivery: bot-assigned external tickets get an Approve/Decline card in
  // the org's approval channel. Never awaited — a Slack outage must not fail the
  // ticket (the platform UI remains the fallback approval surface).
  if (store === 'default') {
    void notifyApprovalForExternalTicket(dto, orgCustomerId).catch(() => undefined);
    // Machine-created → the org's consumers hear about it. Org-scoped so every
    // key serving this org gets the event, not just the one that wrote it.
    void emitOrgTicketEvent({ customerId: orgCustomerId!, type: 'ticket.created', ticket: dto }).catch(() => undefined);
  } else {
    void emitTicketEvent({ keyId: external.keyId, type: 'ticket.created', ticket: dto }).catch(() => undefined);
  }
  return dto;
}

export async function updateTicket(req: Request, id: string, input: ExternalUpdateTicketInput): Promise<TicketDTO> {
  return runExternalStore(req, async () => {
    await assertTicketInScope(req, id);
    const before = await getTicketCore(id);
    const actor = await ticketActor(id);
    const dto = await ticketing.updateTicket(actor, id, input);
    if (input.status && before && before.status !== dto.status) {
      // A status the machine itself changed is a status_changed event for the
      // key that made the change (or, default store, the whole org's consumers).
      const org = req.external!.store === 'default' ? await resolveTicketOrg(id) : null;
      if (org) void emitOrgTicketEvent({ customerId: org, type: 'ticket.status_changed', ticket: dto }).catch(() => undefined);
      else void emitTicketEvent({ keyId: req.external!.keyId, type: 'ticket.status_changed', ticket: dto }).catch(() => undefined);
    }
    return dto;
  });
}

export async function listComments(req: Request, id: string) {
  return runExternalStore(req, async () => {
    await assertTicketInScope(req, id);
    return dbListComments(id);
  });
}

export async function addComment(req: Request, id: string, content: string) {
  return runExternalStore(req, async () => {
    await assertTicketInScope(req, id);
    const actor = await ticketActor(id);
    // Mentions are a platform-UI feature; machine comments notify nobody.
    const comments = await ticketing.addComment(actor, id, content, [], { mentions: [], actorB2bUserId: '' });
    const added = comments[comments.length - 1];
    if (added) {
      const ticket = await ticketing.getTicket(id);
      const org = req.external!.store === 'default' ? await resolveTicketOrg(id) : null;
      if (org) void emitOrgTicketEvent({ customerId: org, type: 'ticket.comment_added', ticket: ticket!, comment: added }).catch(() => undefined);
      else void emitTicketEvent({ keyId: req.external!.keyId, type: 'ticket.comment_added', ticket: ticket!, comment: added }).catch(() => undefined);
    }
    return comments;
  });
}

export async function listProjects(req: Request) {
  return runExternalStore(req, () => ticketing.listProjects());
}

// ponytail: search = reuse of listTickets({search, customerIds}). Upgrade path
// is a dedicated resolver if the consumer ever needs "search X in org A, B".
export async function searchTickets(req: Request, q: string): Promise<TicketDTO[]> {
  return runExternalStore(req, async () => {
    const customerIds = await allowedCustomerIds(req);
    return ticketing.listTickets({ search: q, ...(customerIds === undefined ? {} : { customerIds }) });
  });
}