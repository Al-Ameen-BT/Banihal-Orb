import { Request, Response, NextFunction } from 'express';
import { ExternalCommentSchema, ExternalCreateTicketSchema, ExternalListTicketsSchema, ExternalSearchSchema, ExternalUpdateTicketSchema } from './external.schema';
import * as service from './external-tickets.service';

const handle = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await fn(req)); } catch (err) { next(err); }
  };

export const listTickets = handle((req) =>
  service.listTickets(req, ExternalListTicketsSchema.parse(req.query)));

export const getTicket = handle((req) =>
  service.getTicket(req, req.params['id']!));

export const createTicket = handle((req) =>
  service.createTicket(req, ExternalCreateTicketSchema.parse(req.body)));

export const updateTicket = handle((req) =>
  service.updateTicket(req, req.params['id']!, ExternalUpdateTicketSchema.parse(req.body)));

export const listComments = handle((req) =>
  service.listComments(req, req.params['id']!));

export const addComment = handle((req) =>
  service.addComment(req, req.params['id']!, ExternalCommentSchema.parse(req.body).content));

export const listProjects = handle((req) =>
  service.listProjects(req));

export const searchTickets = handle((req) =>
  service.searchTickets(req, ExternalSearchSchema.parse(req.query).q));