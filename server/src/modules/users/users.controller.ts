import { Request, Response, NextFunction } from 'express';
import { UpdateMeSchema, InviteUserSchema, ChangeRoleSchema, PaginationSchema } from './users.schema';
import * as usersService from './users.service';

export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await usersService.getMe(req.user.userId);
    res.json(user);
  } catch (err) { next(err); }
}

export async function updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateMeSchema.parse(req.body);
    const user = await usersService.updateMe(req.user.userId, input);
    res.json(user);
  } catch (err) { next(err); }
}

export async function listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pagination = PaginationSchema.parse(req.query);
    const result = await usersService.listUsers(pagination);
    res.json(result);
  } catch (err) { next(err); }
}

export async function inviteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = InviteUserSchema.parse(req.body);
    const user = await usersService.inviteUser(input, req.user.customerId);
    res.status(201).json(user);
  } catch (err) { next(err); }
}

export async function changeRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ChangeRoleSchema.parse(req.body);
    const user = await usersService.changeRole(req.params['id']!, input);
    res.json(user);
  } catch (err) { next(err); }
}

export async function removeUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await usersService.removeUser(req.params['id']!, req.user.userId);
    res.status(204).send();
  } catch (err) { next(err); }
}
