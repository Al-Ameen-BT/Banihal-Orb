import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, request, createTestOrg, createTestUser, loginAs, cleanDb } from './helpers';
import { prisma } from '../src/config/database';

// Wires the signed client to the HTTP surface: role derivation from the session,
// the staff guard on complaints, and the "not configured" fallback. The signing
// itself is covered offline in agent-signing.test.ts.
//
// No agent credentials are set in the test env, so every call that reaches the
// client stops at the enabled() gate — which is exactly the assertion that matters
// here: the request got through auth, routing and RBAC to the integration.

describe('agent /v1 routes', () => {
  let userCookies: string[];
  let adminCookies: string[];

  beforeAll(async () => {
    await cleanDb();
    const org = await createTestOrg('Agent Test Org');
    await createTestUser(org.id, 'agent-user@example.com', 'USER');
    await createTestUser(org.id, 'agent-admin@example.com', 'ORG_ADMIN');
    userCookies = await loginAs('agent-user@example.com');
    adminCookies = await loginAs('agent-admin@example.com');
  });

  afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

  it('rejects an unauthenticated caller', async () => {
    expect((await request(app).get('/api/agent/top-complaints')).status).toBe(401);
    expect((await request(app).post('/api/agent/chat').send({ message: 'hi' })).status).toBe(401);
  });

  it('keeps complaints to management roles', async () => {
    const res = await request(app).get('/api/agent/top-complaints').set('Cookie', userCookies);
    expect(res.status).toBe(403);
  });

  it('lets a staff role through to the integration', async () => {
    const res = await request(app).get('/api/agent/top-complaints').set('Cookie', adminCookies);
    // Past the guard; stopped only because no credential is configured in tests.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AGENT_NOT_CONFIGURED');
  });

  it('validates the message before spending a signed round trip', async () => {
    const res = await request(app).post('/api/agent/chat').set('Cookie', userCookies).send({ message: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a role outside the agent\'s five audiences locally', async () => {
    const res = await request(app).post('/api/agent/chat').set('Cookie', userCookies)
      .send({ message: 'hi', role: 'root' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a valid request and reaches the integration', async () => {
    const res = await request(app).post('/api/agent/chat').set('Cookie', userCookies)
      .send({ message: 'how do I reset my VPN?' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AGENT_NOT_CONFIGURED');
  });
});
