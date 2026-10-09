import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { signSchemeB, agentRoleFor, AGENT_ROLES } from '../src/services/agentApi';

// The agent rejects a bad signature with a flat 401 and no detail — by design, but
// it means a signing regression is undebuggable from the response alone. These pin
// the scheme to the agent's documented rules (API_INTEGRATION.md, "Scheme B").

const SECRET = 'test-secret';
const expected = (payload: string) =>
  crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

describe('agent Scheme B signing', () => {
  it('signs timestamp + "." + body', () => {
    expect(signSchemeB(SECRET, '1756400000', '{"message":"hi","role":"l1"}'))
      .toBe(expected('1756400000.{"message":"hi","role":"l1"}'));
  });

  it('signs the empty string for a GET, keeping the trailing dot', () => {
    // Rule 3: the payload is `${ts}.` with nothing after it — NOT the bare timestamp.
    expect(signSchemeB(SECRET, '1756400000', '')).toBe(expected('1756400000.'));
    expect(signSchemeB(SECRET, '1756400000', '')).not.toBe(expected('1756400000'));
  });

  it('keeps the separator load-bearing', () => {
    // Rule 1: without the ".", ("12","3body") and ("123","body") would collide.
    expect(signSchemeB(SECRET, '12', '3body')).not.toBe(signSchemeB(SECRET, '123', 'body'));
  });

  it('is sensitive to byte-level body differences', () => {
    // Rule 2: re-serialising between sign and send (key order, spacing) is the #1
    // integration bug — these must not hash alike.
    const compact = '{"message":"hi","role":"l1"}';
    expect(signSchemeB(SECRET, '1', compact))
      .not.toBe(signSchemeB(SECRET, '1', '{"role":"l1","message":"hi"}'));
    expect(signSchemeB(SECRET, '1', compact))
      .not.toBe(signSchemeB(SECRET, '1', '{ "message": "hi", "role": "l1" }'));
  });

  it('produces 64 hex characters, the format the agent validates', () => {
    expect(signSchemeB(SECRET, '1756400000', '{}')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('platform role → agent audience role', () => {
  it('maps every platform role to a role the agent accepts', () => {
    for (const platform of ['USER', 'ORG_ADMIN', 'ADMINISTRATOR']) {
      expect(AGENT_ROLES).toContain(agentRoleFor(platform));
    }
  });

  it('never leaks an engineer-level audience to an ordinary user', () => {
    expect(agentRoleFor('USER')).toBe('end_user');
  });

  it('falls back to the most restrictive role for an unknown platform role', () => {
    expect(agentRoleFor('SOMETHING_NEW')).toBe('end_user');
  });
});
