import crypto from 'crypto';
import os from 'node:os';
import { prisma } from '../../config/database';
import { redis } from '../../lib/redis';

const unavailable = (code: string, message: string) => Object.assign(new Error(message), { status: 503, code });

export async function automationState(proxyId: string, customerId: string) {
  const controls = await prisma.squidAutomationControl.findMany({ where: { id: { in: ['global', 'global:overload', `client:${customerId}`, `proxy:${proxyId}`] } } });
  const active = controls.filter(c => c.paused);
  return { paused: active.length > 0, reasons: active.map(c => c.reason), scopes: active.map(c => c.id), pollIntervalMs: 30_000 };
}

export async function assertAutomationRunning(proxyId: string, customerId: string): Promise<void> {
  if ((await automationState(proxyId, customerId)).paused) throw unavailable('SQUID_AUTOMATION_PAUSED', 'Proxy automation is paused; existing Squid traffic is unchanged.');
}

export async function setAutomationPause(id: string, paused: boolean, reason: string, actorId: string) {
  if (id === 'global' && !paused) {
    await prisma.squidAutomationControl.updateMany({ where: { id: 'global:overload' }, data: { paused: false, reason, actorId } });
  }
  const control = await prisma.squidAutomationControl.upsert({ where: { id }, create: { id, paused, reason, actorId }, update: { paused, reason, actorId } });
  if (!paused) {
    const scope = id.startsWith('proxy:') ? { proxyId: id.slice(6) } : id.startsWith('client:') ? { customerId: id.slice(7) } : {};
    // Time spent intentionally paused must not time out an awaiting host receipt.
    await prisma.squidBotCommand.updateMany({ where: { ...scope, status: 'DISPATCHED' }, data: { dispatchedAt: new Date() } });
  }
  return control;
}

export function platformOverloaded(loadPerCpu: number, memoryFraction: number): boolean {
  return loadPerCpu >= 0.85 || memoryFraction >= 0.9;
}

export function startSquidOverloadGuard(): void {
  let busy = false, highSamples = 0;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const high = platformOverloaded(os.loadavg()[0]! / Math.max(os.cpus().length, 1), 1 - os.freemem() / os.totalmem());
      highSamples = high ? highSamples + 1 : 0;
      if (highSamples >= 3) {
        await setAutomationPause('global:overload', true, 'Sustained platform resource pressure; inspect capacity before resuming', 'system:overload');
      }
    } catch { console.error('Squid overload monitor unavailable; inspect control storage'); }
    finally { busy = false; }
  }, 30_000);
  timer.unref();
}

export async function withProxyLease<T>(proxyId: string, work: () => Promise<T>): Promise<T> {
  if (!redis || redis.status !== 'ready') throw unavailable('SQUID_CONTROL_UNAVAILABLE', 'Distributed control storage unavailable');
  const token = crypto.randomUUID();
  const key = `b2b:squid:lease:${proxyId}`;
  if (await redis.set(key, token, 'PX', 120_000, 'NX') !== 'OK') throw unavailable('SQUID_BUSY', 'A proxy operation is already in progress');
  let lost = false;
  const renewal = setInterval(() => {
    void redis!.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], 120000) else return 0 end", 1, key, token)
      .then(result => { if (Number(result) !== 1) lost = true; }).catch(() => { lost = true; });
  }, 30_000);
  renewal.unref();
  try {
    const result = await work();
    if (lost) throw unavailable('SQUID_CONTROL_UNAVAILABLE', 'Proxy lease lost; retry using the same request key');
    return result;
  }
  finally {
    clearInterval(renewal);
    // Release only our lease; an expired lease may already belong to another worker.
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token).catch(() => undefined);
  }
}

export async function admitProxyChange(proxyId: string, customerId: string): Promise<void> {
  await assertAutomationRunning(proxyId, customerId);
  if (!redis || redis.status !== 'ready') throw unavailable('SQUID_CONTROL_UNAVAILABLE', 'Distributed control storage unavailable');
  const key = `b2b:squid:submit:${customerId}:${Math.floor(Date.now() / 60_000)}`;
  const accepted = await redis.eval("local n = redis.call('incr', KEYS[1]); if n == 1 then redis.call('expire', KEYS[1], 120) end; return n", 1, key);
  if (Number(accepted) > 30) throw Object.assign(new Error('Client change rate exceeded; retry later'), { status: 429, code: 'SQUID_RATE_LIMITED' });
  const pending = await prisma.squidChangeRequest.count({ where: { proxyId, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED'] } } });
  if (pending >= 100) throw unavailable('SQUID_QUEUE_FULL', 'Proxy change queue is full');
}
