import { Request, Response, NextFunction } from 'express';
import { CreateRequestSchema, ListMyRequestsSchema, ListOrgRequestsSchema } from './requests.schema';
import * as requestsService from './requests.service';

export async function createRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateRequestSchema.parse(req.body);
    const request = await requestsService.createRequest(req.user.customerId, req.user.userId, input);
    res.status(201).json(request);
  } catch (err) { next(err); }
}

export async function listMyRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListMyRequestsSchema.parse(req.query);
    const result = await requestsService.listMyRequests(req.user.userId, input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listOrgRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListOrgRequestsSchema.parse(req.query);
    const result = await requestsService.listOrgRequests(req.user.customerId, input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getMyRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const request = await requestsService.getMyRequest(req.params['id']!, req.user.userId);
    res.json(request);
  } catch (err) { next(err); }
}

export async function closeMyRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const request = await requestsService.closeMyRequest(req.params['id']!, req.user.userId);
    res.json(request);
  } catch (err) { next(err); }
}
