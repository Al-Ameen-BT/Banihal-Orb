import { Request, Response, NextFunction } from 'express';
import {
  ListTicketsSchema, CreateTicketSchema, UpdateTicketSchema,
  CreateProjectSchema, UpdateProjectSchema, CreateSlaSchema, ReportSchema, UpdateEscalationSchema,
} from './ticketing.schema';
import * as service from './ticketing.service';
import * as db from './ticketing.client';
import * as escalation from './services/escalation';
import { resolveTicketActor } from './identity';

// Bridge the B2B-Site user to a ticketing staff Users row (id + mapped role).
const actor = (req: Request) => resolveTicketActor(req.user.userId, req.user.role);

export async function listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListTicketsSchema.parse(req.query);
    const me = input.mine ? await actor(req) : null;
    const tickets = await service.listTickets({
      ...(input.status ? { status: input.status } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(me ? { mineUserId: me.id } : {}),
    });
    res.json({ tickets });
  } catch (err) { next(err); }
}

export async function getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ticket = await service.getTicket(req.params['id']!);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' }); return; }
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateTicketSchema.parse(req.body);
    const me = await actor(req);
    const ticket = await service.createTicket(me.id, input);
    res.status(201).json(ticket);
  } catch (err) { next(err); }
}

export async function updateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateTicketSchema.parse(req.body);
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

export async function listAssignees(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ assignees: await db.listStaff() }); } catch (err) { next(err); }
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
export async function getComments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ comments: await service.listComments(req.params['id']!) }); } catch (err) { next(err); }
}
export async function addComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const content = String(req.body?.content ?? '').trim();
    if (!content) { res.status(400).json({ error: 'content is required', code: 'BAD_REQUEST' }); return; }
    const me = await actor(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    res.status(201).json({ comments: await service.addComment(me.id, req.params['id']!, content, files) });
  } catch (err) { next(err); }
}
export async function getActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ activity: await service.listActivities(req.params['id']!) }); } catch (err) { next(err); }
}
export async function getTicketAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ attachments: await service.listTicketAttachments(req.params['id']!) }); } catch (err) { next(err); }
}
export async function uploadTicketAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const me = await actor(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) { res.status(400).json({ error: 'No files uploaded', code: 'BAD_REQUEST' }); return; }
    res.status(201).json({ attachments: await service.addTicketAttachments(me.id, req.params['id']!, files) });
  } catch (err) { next(err); }
}
export async function downloadAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = await service.getAttachmentFile(req.params['id']!);
    if (!file?.path) { res.status(404).json({ error: 'Attachment not found', code: 'NOT_FOUND' }); return; }
    res.download(file.path, file.originalName ?? 'attachment');
  } catch (err) { next(err); }
}
export async function getWatchers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ watchers: await service.listWatchers(req.params['id']!) }); } catch (err) { next(err); }
}
export async function watchTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { const me = await actor(req); await service.watch(req.params['id']!, me.id); res.status(204).end(); } catch (err) { next(err); }
}
export async function unwatchTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { const me = await actor(req); await service.unwatch(req.params['id']!, me.id); res.status(204).end(); } catch (err) { next(err); }
}

// ─── Escalation (ORG_ADMIN → b2b_ticketing_admin / ADMINISTRATOR portal) ────────
export async function escalateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const me = await actor(req);
    res.status(201).json(await escalation.escalateTicket(me.id, req.user.customerId, req.params['id']!));
  } catch (err) { next(err); }
}
export async function listEscalations(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ escalations: await escalation.listEscalations() }); } catch (err) { next(err); }
}
export async function updateEscalation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await escalation.updateEscalation(req.params['id']!, UpdateEscalationSchema.parse(req.body))); } catch (err) { next(err); }
}
