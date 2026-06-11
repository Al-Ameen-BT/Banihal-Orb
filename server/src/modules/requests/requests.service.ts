import { prisma } from '../../config/database';
import type { CreateRequestInput, ListMyRequestsInput, ListOrgRequestsInput } from './requests.schema';

// customerId is passed explicitly because `create` is not auto-scoped by the
// tenant Prisma extension (only find*/update*/delete*/count are). All read ops
// below run under tenant context and get customerId injected automatically.

// internalNotes is platform-admin-only — never expose it on org-facing endpoints.
function stripInternal<T extends { internalNotes?: unknown }>(r: T): Omit<T, 'internalNotes'> {
  const { internalNotes: _internal, ...rest } = r;
  return rest;
}

export async function createRequest(customerId: string, userId: string, input: CreateRequestInput) {
  const created = await prisma.serviceRequest.create({
    data: {
      customerId,
      createdById: userId,
      subject: input.subject,
      type: input.type,
      priority: input.priority,
      service: input.service ?? null,
      description: input.description ?? null,
    },
  });
  return stripInternal(created);
}

export async function listMyRequests(userId: string, input: ListMyRequestsInput) {
  const skip = (input.page - 1) * input.limit;
  const where = {
    createdById: userId,
    ...(input.status ? { status: input.status } : {}),
  };

  const [requests, total] = await Promise.all([
    prisma.serviceRequest.findMany({
      where, skip, take: input.limit,
      orderBy: [{ createdAt: 'desc' }],
    }),
    prisma.serviceRequest.count({ where }),
  ]);

  return { requests: requests.map(stripInternal), total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

// Org-admin view — every ticket in the organization. customerId is set explicitly
// because groupBy is NOT auto-scoped by the tenant extension (only find*/count
// /update*/delete* are); scoping it by hand prevents cross-org count leakage.
export async function listOrgRequests(customerId: string, input: ListOrgRequestsInput) {
  const skip = (input.page - 1) * input.limit;
  const where = {
    customerId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.type ? { type: input.type } : {}),
  };

  const [requests, total, statusGroups] = await Promise.all([
    prisma.serviceRequest.findMany({
      where, skip, take: input.limit,
      include: { createdBy: { select: { id: true, name: true, email: true } } },
      orderBy: [{ createdAt: 'desc' }],
    }),
    prisma.serviceRequest.count({ where }),
    prisma.serviceRequest.groupBy({ by: ['status'], where: { customerId }, _count: { _all: true } }),
  ]);

  const counts = statusGroups.reduce<Record<string, number>>((acc, g) => {
    acc[g.status] = g._count._all;
    return acc;
  }, {});

  return { requests: requests.map(stripInternal), total, counts, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function getMyRequest(id: string, userId: string) {
  const request = await prisma.serviceRequest.findFirst({ where: { id, createdById: userId } });
  if (!request) throw Object.assign(new Error('Request not found'), { status: 404, code: 'NOT_FOUND' });
  return stripInternal(request);
}

export async function closeMyRequest(id: string, userId: string) {
  // findFirst enforces ownership (+ tenant scope via the extension) before mutating.
  const existing = await prisma.serviceRequest.findFirst({ where: { id, createdById: userId } });
  if (!existing) throw Object.assign(new Error('Request not found'), { status: 404, code: 'NOT_FOUND' });

  const updated = await prisma.serviceRequest.update({
    where: { id },
    data: { status: 'CLOSED', resolvedAt: existing.resolvedAt ?? new Date() },
  });
  return stripInternal(updated);
}
