import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock('../src/config/database', () => ({ prisma: { machineIdentity: { findUnique: mocks.identity } } }));
vi.mock('../src/lib/redis', () => ({ redis: null }));
vi.mock('../src/lib/audit', () => ({ audit: vi.fn() }));
import { canonicalMachineV2, reserveNonce, verifyCertificateBinding, machineIdentity } from '../src/lib/machineProtocol';
import { verifyMachineSignature, createMachineKeyAuth } from '../src/lib/machineAuth';

describe('machine protocol v2', () => {
  it('binds actor, nonce, timestamp, method, full URL and body hash unambiguously', () => {
    const hash = crypto.createHash('sha256').update('{"ok":true}').digest('hex');
    expect(canonicalMachineV2('proxy:p1', '123', 'a'.repeat(32), 'post', '/api/result?x=1', hash))
      .toBe(['B2B-MACHINE-V2', 'proxy:p1', '123', 'a'.repeat(32), 'POST', '/api/result?x=1', hash].join('\n'));
  });
  it('requires an exact SHA256 certificate fingerprint belonging to the machine', () => {
    expect(verifyCertificateBinding('aa'.repeat(32), 'AA:'.repeat(31) + 'AA')).toBe(true);
    expect(verifyCertificateBinding('aa'.repeat(32), 'bb'.repeat(32))).toBe(false);
    expect(verifyCertificateBinding('', '')).toBe(false);
  });
  it('atomically accepts a nonce once across concurrent requests', async () => {
    const seen = new Set<string>();
    const store = { status: 'ready', set: vi.fn(async (key: string) => {
      if (seen.has(key)) return null;
      seen.add(key); return 'OK';
    }) };
    const results = await Promise.all([reserveNonce('proxy:p1', 'a'.repeat(32), store), reserveNonce('proxy:p1', 'a'.repeat(32), store)]);
    expect(results.sort()).toEqual([false, true]);
    expect(store.set.mock.calls[0]?.slice(2)).toEqual(['PX', 600001, 'NX']);
  });
  it('fails closed when replay storage is absent or unavailable', async () => {
    await expect(reserveNonce('proxy:p1', 'a'.repeat(32), null)).rejects.toThrow('Replay protection unavailable');
    await expect(reserveNonce('proxy:p1', 'a'.repeat(32), { status: 'ready', set: async () => { throw Error('down'); } })).rejects.toThrow();
  });
  it('rejects modification of a v2 body, URL, identity or nonce', () => {
    const tsMs = Date.now(), actor = 'proxy:p1', nonce = 'a'.repeat(32), secret = 'test-key';
    const rawBody = Buffer.from('{"seq":1}');
    const sig = crypto.createHmac('sha256', secret).update(canonicalMachineV2(actor, String(tsMs), nonce, 'POST', '/result?q=1', crypto.createHash('sha256').update(rawBody).digest('hex'))).digest('hex');
    const input = { tsMs, sig, secret, rawBody, method: 'POST', path: '/result?q=1', v2: { actor, nonce } };
    expect(verifyMachineSignature(input)).toEqual({ ok: true });
    for (const change of [{ rawBody: Buffer.from('{}') }, { path: '/result?q=2' }, { method: 'DELETE' }, { v2: { actor: 'proxy:p2', nonce } }, { v2: { actor, nonce: 'b'.repeat(32) } }]) {
      expect(verifyMachineSignature({ ...input, ...change })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    }
  });
  it('does not accept a certificate assertion from an untrusted upstream', async () => {
    mocks.identity.mockResolvedValue({ enabled: true, minVersion: 2, certificateSha256: 'aa'.repeat(32) });
    expect(await machineIdentity({ socket: { remoteAddress: '203.0.113.1' }, app: { get: () => () => false } } as any, 'proxy:p1')).toBeNull();
  });
  it('rejects legacy signatures after machine enrolment', async () => {
    const certificate = readFileSync(new URL('./fixtures/machine-client.pem', import.meta.url), 'utf8');
    const fingerprint = new crypto.X509Certificate(certificate).fingerprint256.replace(/:/g, '').toLowerCase();
    mocks.identity.mockResolvedValue({ enabled: true, minVersion: 2, certificateSha256: fingerprint });
    const next = vi.fn();
    const res = { locals: {}, headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req = { get: (name: string) => ({ 'X-Proxy-Timestamp': String(Date.now()), Authorization: 'Bearer ' + 'aa'.repeat(32), 'X-Machine-Verified': 'SUCCESS', 'X-Machine-Certificate': encodeURIComponent(certificate) }[name]), socket: { remoteAddress: '127.0.0.1' }, app: { get: () => () => true }, secure: true };
    await createMachineKeyAuth({ actorKind: 'proxy', actorIdOf: () => 'p1', timestampHeader: 'X-Proxy-Timestamp', loadActor: async () => ({ actorId: 'p1', context: {}, secret: 'key' }), reqKey: 'proxy', authFailedCode: 'DENIED', auditAction: 'SQUID_AGENT_AUTH_FAILED' })(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
  });
  it('a valid v2 request cannot execute when replay storage is unavailable', async () => {
    const certificate = readFileSync(new URL('./fixtures/machine-client.pem', import.meta.url), 'utf8');
    const fingerprint = new crypto.X509Certificate(certificate).fingerprint256.replace(/:/g, '').toLowerCase();
    mocks.identity.mockResolvedValue({ enabled: true, minVersion: 2, certificateSha256: fingerprint });
    const ts = String(Date.now()), nonce = 'c'.repeat(32), secret = 'key';
    const sig = crypto.createHmac('sha256', secret).update(canonicalMachineV2('proxy:p1', ts, nonce, 'GET', '/api/proxy-agent/poll', crypto.createHash('sha256').update('').digest('hex'))).digest('hex');
    const headers: Record<string, string> = { 'X-Proxy-Timestamp': ts, Authorization: `Bearer ${sig}`, 'X-Machine-Version': '2', 'X-Machine-Nonce': nonce, 'X-Machine-Verified': 'SUCCESS', 'X-Machine-Certificate': encodeURIComponent(certificate) };
    const req = { method: 'GET', originalUrl: '/api/proxy-agent/poll', get: (name: string) => headers[name], socket: { remoteAddress: '127.0.0.1' }, app: { get: () => () => true }, secure: true };
    const next = vi.fn(), disable = vi.fn();
    const res = { locals: {}, headersSent: false, setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    const auth = createMachineKeyAuth({ actorKind: 'proxy', actorIdOf: () => 'p1', timestampHeader: 'X-Proxy-Timestamp', loadActor: async () => ({ actorId: 'p1', context: {}, secret }), reqKey: 'proxy', authFailedCode: 'DENIED', auditAction: 'SQUID_AGENT_AUTH_FAILED', onBruteForceDisable: disable });
    await auth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(503); expect(next).not.toHaveBeenCalled();
    headers.Authorization = 'Bearer ' + '00'.repeat(32);
    for (let i = 0; i < 6; i++) await auth(req as any, res as any, next);
    expect(disable).not.toHaveBeenCalled();
  });
});
