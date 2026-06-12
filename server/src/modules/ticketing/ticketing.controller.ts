import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';
import {
  ListTicketsSchema, CreateTicketSchema, UpdateTicketSchema,
  CreateProjectSchema, ReportSchema, AlertsSchema, EscalateSchema,
} from './ticketing.schema';
import * as ticketingService from './ticketing.service';

async function currentUser(req: Request): Promise<{ name: string; email: string }> {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true, email: true },
  });
  return user ?? { name: 'Unknown', email: 'unknown@unknown' };
}

export async function listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListTicketsSchema.parse(req.query);
    const me = input.mine ? await currentUser(req) : null;
    const tickets = await ticketingService.listTickets(req.user.customerId, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(me ? { mine: me.email } : {}),
    });
    res.json({ tickets, fallback: ticketingService.usingFallback() });
  } catch (err) { next(err); }
}

export async function createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateTicketSchema.parse(req.body);
    const raisedBy = await currentUser(req);
    const ticket = await ticketingService.createTicket(req.user.customerId, { ...input, raisedBy });
    res.status(201).json(ticket);
  } catch (err) { next(err); }
}

export async function updateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateTicketSchema.parse(req.body);
    const ticket = await ticketingService.updateTicket(req.user.customerId, req.params['id']!, input);
    res.json(ticket);
  } catch (err) { next(err); }
}

export async function escalateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = EscalateSchema.parse(req.body ?? {});
    const escalation = await ticketingService.escalateTicket(
      req.user.customerId, req.user.userId, req.params['id']!, input.note,
    );
    res.status(201).json(escalation);
  } catch (err) { next(err); }
}

export async function getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await ticketingService.getStats(req.user.customerId));
  } catch (err) { next(err); }
}

export async function getAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await ticketingService.getAnalytics(req.user.customerId));
  } catch (err) { next(err); }
}

export async function listProjects(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const projects = await ticketingService.listProjects(req.user.customerId);
    res.json({ projects });
  } catch (err) { next(err); }
}

export async function createProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateProjectSchema.parse(req.body);
    const project = await ticketingService.createProject(req.user.customerId, input);
    res.status(201).json(project);
  } catch (err) { next(err); }
}

export async function deleteProject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await ticketingService.deleteProject(req.user.customerId, req.params['id']!);
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ReportSchema.parse(req.query);
    res.json(await ticketingService.getReport(req.user.customerId, input.type, input.from, input.to));
  } catch (err) { next(err); }
}

export async function getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = AlertsSchema.parse(req.query);
    const me = await currentUser(req);
    const tickets = await ticketingService.getNewTickets(req.user.customerId, input.since, me.email);
    res.json({ tickets, now: new Date().toISOString() });
  } catch (err) { next(err); }
}
