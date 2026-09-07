// The signed /v1 surface has no test instance, so these run against a local
// stand-in that verifies signatures the way the real agent does. What is pinned
// here is the half we own: the bytes we sign, the roles we ask for, and how each
// upstream failure is turned into something safe for the browser. No database.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

const CLIENT_ID = 'ext-test';
const SECRET = 'topsecret';

type Reply = { status: number; body: unknown };
let respond: (role: string) => Reply;
let seen: { role: string; signatureValid: boolean; ts: string }[] = [];
let inFlight = 0;
let maxInFlight = 0;
let server: http.Server;
let api: typeof import('../src/services/agentApi');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      // The agent signs `${timestamp}.${body}` over the EXACT bytes received — so
      // does this, which is what makes re-serialisation bugs fail the test.
      const ts = String(req.headers['x-timestamp'] ?? '');
      const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
      const role = String((JSON.parse(raw || '{}') as { role?: string }).role ?? '');
      seen.push({ role, signatureValid: req.headers['x-signature'] === expected, ts });

      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25)); // hold the slot, like a model call
      inFlight -= 1;

      const { status, body } = respond(role);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // env.ts parses process.env once at import, so configure before first import.
  process.env.AGENT_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AGENT_CHAT_CLIENT_ID = CLIENT_ID;
  process.env.AGENT_CHAT_SECRET = SECRET;
  process.env.AGENT_CHAT_TIMEOUT_MS = '5000';
  api = await import('../src/services/agentApi');
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  seen = []; maxInFlight = 0;
  respond = (role) => ({ status: 200, body: { reply: `answer for ${role}`, role } });
});

describe('signSchemeB', () => {
  it('signs `${timestamp}.${body}` — the dot is load-bearing', () => {
    // Without the separator, ("12","3body") and ("123","body") would collide.
    expect(api.signSchemeB('k', '12', '3body')).not.toBe(api.signSchemeB('k', '123', 'body'));
    expect(api.signSchemeB('k', '123', 'body'))
      .toBe(crypto.createHmac('sha256', 'k').update('123.body').digest('hex'));
  });
});

describe('agentChat', () => {
  it('sends a signature the agent can verify over the exact body bytes', async () => {
    const { reply, role } = await api.agentChat('how do I reset my vpn?', 'l3');
    expect(reply).toBe('answer for l3');
    expect(role).toBe('l3');
    expect(seen[0]).toMatchObject({ role: 'l3', signatureValid: true });
  });

  it('falls back to end_user when the credential is not granted the mapped role', async () => {
    // Measured in prod: ext-55df9387 granted only end_user, so every ADMINISTRATOR
    // chat 403'd and left an orphan user turn in the history.
    respond = (role) => role === 'l3'
      ? { status: 403, body: { error: 'role_not_allowed' } }
      : { status: 200, body: { reply: 'downgraded answer', role } };

    const res = await api.agentChat('hi', 'l3');
    expect(res).toEqual({ reply: 'downgraded answer', role: 'end_user' });
    expect(seen.map((s) => s.role)).toEqual(['l3', 'end_user']);
  });

  it('never passes 401/403 through to the browser — that would sign the user out', async () => {
    for (const code of ['bad_signature', 'stale_timestamp', 'unknown_client']) {
      respond = () => ({ status: 401, body: { error: code } });
      await expect(api.agentChat('hi', 'end_user')).rejects.toMatchObject({ status: 502, code });
    }
  });

  it('retries a busy agent once, then surfaces 429 so the client can say "try again"', async () => {
    let n = 0;
    respond = (role) => { n += 1; return n === 1 ? { status: 429, body: { error: 'server_busy' } } : { status: 200, body: { reply: 'second try', role } }; };
    expect((await api.agentChat('hi', 'end_user')).reply).toBe('second try');
    expect(seen).toHaveLength(2);

    respond = () => ({ status: 429, body: { error: 'server_busy' } });
    await expect(api.agentChat('hi', 'end_user')).rejects.toMatchObject({ status: 429, code: 'server_busy' });
  });

  it('serializes calls — the agent answers one at a time and 429s the rest', async () => {
    await Promise.all([1, 2, 3].map((n) => api.agentChat(`q${n}`, 'end_user')));
    expect(seen).toHaveLength(3);
    expect(maxInFlight).toBe(1);
  });

  it('rejects an unreadable payload rather than showing the user an empty answer', async () => {
    respond = () => ({ status: 200, body: { notAReply: true } });
    await expect(api.agentChat('hi', 'end_user')).rejects.toMatchObject({ code: 'AGENT_MALFORMED' });
  });
});

describe('agentRoleFor', () => {
  it('maps platform roles and falls back to end_user', () => {
    expect(api.agentRoleFor('USER')).toBe('end_user');
    expect(api.agentRoleFor('ORG_ADMIN')).toBe('l1');
    expect(api.agentRoleFor('ADMINISTRATOR')).toBe('l3');
    expect(api.agentRoleFor('SADMIN')).toBe('end_user');
  });
});
