import { Request, Response, NextFunction } from 'express';
import {
  ListTicketsSchema, CreateTicketSchema, UpdateTicketSchema,
  CreateProjectSchema, UpdateProjectSchema, CreateSlaSchema, ReportSchema,
} from './ticketing.schema';
import * as service from './ticketing.service';
import * as db from './ticketing.client';
import * as escalation from './services/escalation';
import { listAdminAssignees } from './services/adminAssignees';
import { resolveTicketActor } from './identity';

// Bridge the B2B-Site user to a ticketing staff Users row (id + mapped role).
const actor = (req: Request) => resolveTicketActor(req.user.userId, req.user.role);

// Synthetic assignee that routes a new ticket to the platform administrators
// (auto-escalation) instead of a person. Offered to ORG_ADMIN only; the client
// translates it into { escalateToAdministrators: true } on submit. Kept in sync
// with the same id in client/src/app/ticketing/shared.tsx.
export const ESCALATE_ADMINS_ID = '__escalate_admins__';

export async function listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListTicketsSchema.parse(req.query);
    const me = input.mine ? await actor(req) : null;
    // Tenant scope: non-admins only ever see their own / their org's tickets.
    const scope = await service.ticketAccessScope(req.user);
    const tickets = await service.listTickets({
      ...(input.status ? { status: input.status } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      ...(input.escalatedOnly ? { escalatedOnly: true } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(me ? { mineUserId: me.id } : {}),
      ...(scope ? { reporterOrAssigneeIn: scope } : {}),
    });
    res.json({ tickets });
  } catch (err) { next(err); }
}

export async function getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = await service.ticketAccessScope(req.user);
    await service.assertTicketAccess(scope, req.params['id']!);
    const ticket = await service.getTicket(req.params['id']!);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' }); return; }
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = CreateTicketSchema.parse(req.body);
    // Client + contact person are ADMINISTRATOR-only fields (the admin store's New
    // Ticket form is the only surface that offers them). Silently drop them for every
    // other role rather than 403 — no org-level client sends them, so a rejection could
    // only ever come from a hand-rolled request trying to pick another org's client.
    const input = req.user.role === 'ADMINISTRATOR'
      ? parsed
      : (({ customerId: _c, contactPerson: _p, ...rest }) => rest)(parsed);
    const me = await actor(req);

    // Org admin picked "Escalate to Administrators" as the assignee: create the
    // ticket in the org store UNASSIGNED, then auto-escalate it to the platform
    // administrators' store. Restricted to ORG_ADMIN (regular users never get the
    // option, and this is the server-side guard).
    if (input.escalateToAdministrators) {
      if (req.user.role !== 'ORG_ADMIN') {
        throw Object.assign(
          new Error('Only organization admins can escalate a ticket to administrators.'),
          { status: 403, code: 'FORBIDDEN' },
        );
      }
      const ticket = await service.createTicket(me.id, { ...input, assigneeId: null }, req.user.customerId);
      await escalation.escalateTicket(req.user.userId, req.user.role, ticket.id);
      res.status(201).json(ticket);
      return;
    }

    const ticket = await service.createTicket(me.id, input, req.user.customerId);
    res.status(201).json(ticket);
  } catch (err) { next(err); }
}

export async function updateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateTicketSchema.parse(req.body);
    const scope = await service.ticketAccessScope(req.user);
    await service.assertTicketAccess(scope, req.params['id']!);
    const me = await actor(req);
    const ticket = await service.updateTicket(me.id, req.params['id']!, input);
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function listProjects(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ projects: await service.listProjects() }); } catch (err) { next(err); }
}

export async function createProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateProjectSchema.parse(req.body);
    const me = await actor(req);
    res.status(201).json(await service.createProject(me.id, input));
  } catch (err) { next(err); }
}

export async function updateProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateProjectSchema.parse(req.body);
    res.json(await service.updateProject(req.params['id']!, input));
  } catch (err) { next(err); }
}

export async function deleteProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { await service.deleteProject(req.params['id']!); res.status(204).end(); } catch (err) { next(err); }
}

export async function listSlas(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ slas: await service.listSlas() }); } catch (err) { next(err); }
}

export async function createSla(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(201).json(await service.createSla(CreateSlaSchema.parse(req.body))); } catch (err) { next(err); }
}

export async function updateSla(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.updateSla(req.params['id']!, CreateSlaSchema.partial().parse(req.body))); } catch (err) { next(err); }
}

export async function deleteSla(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { await service.deleteSla(req.params['id']!); res.status(204).end(); } catch (err) { next(err); }
}

export async function listAssignees(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Admin store's assignee pool is the platform administrators (bridged).
    if (req.user.role === 'ADMINISTRATOR') {
      res.json({ assignees: await listAdminAssignees() });
      return;
    }
    // Org store's pool is its own staff (platform admins are excluded by listStaff).
    // ORG_ADMINs additionally get a synthetic "Escalate to Administrators" option at
    // the top; regular users never see it.
    const staff = await db.listStaff();
    const assignees = req.user.role === 'ORG_ADMIN'
      ? [{ id: ESCALATE_ADMINS_ID, name: 'Escalate to Administrators', email: '', role: 'ADMINISTRATOR' }, ...staff]
      : staff;
    res.json({ assignees });
  } catch (err) { next(err); }
}

// Client pool for the admin New Ticket form. ADMINISTRATOR-only at the route, so this
// always reads the isolated admin store — an org caller can never enumerate clients.
export async function listCustomers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ customers: await db.listCustomers() }); } catch (err) { next(err); }
}

export async function getStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.getStats()); } catch (err) { next(err); }
}

export async function getAnalytics(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.getAnalytics()); } catch (err) { next(err); }
}

export async function getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ReportSchema.parse(req.query);
    res.json(await service.getReport(input.type, input.from, input.to));
  } catch (err) { next(err); }
}

export async function getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const since = String(req.query['since'] ?? '');
    if (!since) { res.status(400).json({ error: 'since is required', code: 'BAD_REQUEST' }); return; }
    const me = await actor(req);
    const tickets = await service.getNewTickets(since, me.id);
    res.json({ tickets, now: new Date().toISOString() });
  } catch (err) { next(err); }
}

// ─── Collaboration ───────────────────────────────────────────────────────────
// Every ticket-scoped surface first verifies the caller may access the ticket
// (tenant-scoped by the bridged reporter/assignee) — otherwise 404.
export async function getComments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    res.json({ comments: await service.listComments(req.params['id']!) });
  } catch (err) { next(err); }
}
export async function addComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const content = String(req.body?.content ?? '').trim();
    if (!content) { res.status(400).json({ error: 'content is required', code: 'BAD_REQUEST' }); return; }
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    const me = await actor(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    res.status(201).json({ comments: await service.addComment(me.id, req.params['id']!, content, files) });
  } catch (err) { next(err); }
}
export async function getActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    res.json({ activity: await service.listActivities(req.params['id']!) });
  } catch (err) { next(err); }
}
export async function getTicketAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    res.json({ attachments: await service.listTicketAttachments(req.params['id']!) });
  } catch (err) { next(err); }
}
export async function uploadTicketAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    const me = await actor(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) { res.status(400).json({ error: 'No files uploaded', code: 'BAD_REQUEST' }); return; }
    res.status(201).json({ attachments: await service.addTicketAttachments(me.id, req.params['id']!, files) });
  } catch (err) { next(err); }
}
export async function downloadAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertAttachmentAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    const file = await service.getAttachmentFile(req.params['id']!);
    if (!file?.path) { res.status(404).json({ error: 'Attachment not found', code: 'NOT_FOUND' }); return; }
    // ?inline=1 serves the bytes for rendering in the page (<img src>) instead of
    // forcing a download — same access check either way.
    if (req.query['inline']) {
      res.type(file.mimeType ?? 'application/octet-stream');
      res.sendFile(file.path);
      return;
    }
    res.download(file.path, file.originalName ?? 'attachment');
  } catch (err) { next(err); }
}
export async function getWatchers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    res.json({ watchers: await service.listWatchers(req.params['id']!) });
  } catch (err) { next(err); }
}
export async function watchTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    const me = await actor(req); await service.watch(req.params['id']!, me.id); res.status(204).end();
  } catch (err) { next(err); }
}
export async function unwatchTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    const me = await actor(req); await service.unwatch(req.params['id']!, me.id); res.status(204).end();
  } catch (err) { next(err); }
}

// ─── Escalation: ORG_ADMIN/ADMINISTRATOR copies a b2b_ticket ticket into the
//     administrators' store (b2b_ticketing_admin, same 14-table schema). ───────
export async function escalateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // The source lives in the caller's (default) store — verify org access first.
    await service.assertTicketAccess(await service.ticketAccessScope(req.user), req.params['id']!);
    res.status(201).json(await escalation.escalateTicket(req.user.userId, req.user.role, req.params['id']!));
  } catch (err) { next(err); }
}

// ─── Notifications ───────────────────────────────────────────────────────────
// Every role: updates on the tickets they reported.
export async function myUpdates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const since = String(req.query['since'] ?? new Date().toISOString());
    const me = await actor(req);
    res.json({ updates: await service.getMyTicketUpdates(me.id, since), now: new Date().toISOString() });
  } catch (err) { next(err); }
}

// ADMINISTRATOR: new escalated tickets in the admin store (notify-all source).
export async function escalationAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const since = String(req.query['since'] ?? new Date().toISOString());
    const me = await actor(req);
    res.json({ tickets: await service.getEscalationAlerts(since, me.id), now: new Date().toISOString() });
  } catch (err) { next(err); }
}

// ADMINISTRATOR: first-wins claim of an escalated ticket → self-assign.
export async function claimTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const me = await actor(req);
    res.json(await service.claimTicket(me.id, req.params['id']!));
  } catch (err) { next(err); }
}
