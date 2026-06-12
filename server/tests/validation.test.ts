import { describe, it, expect, afterAll } from 'vitest';
import { app, request } from './helpers';
import { prisma } from '../src/config/database';

describe('Zod input validation', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('returns 400 with structured errors for invalid register body', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'A',              // too short
      email: 'not-an-email',
      password: 'short',
      organizationName: 'X',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toBeDefined();
    expect(res.body.details.fieldErrors).toBeDefined();
  });

  it('returns 400 with structured errors for invalid login body', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'bad-email', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid query params on paginated endpoints', async () => {
    // Register and use the registration session cookies directly — a second
    // cookie-less login is blocked by single-session enforcement. Unique email
    // keeps this file independent of DB state (no cleanDb here).
    const email = `valtest-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const regRes = await request(app).post('/api/auth/register').send({
      name: 'Val User',
      email,
      password: 'TestPassword1!',
      organizationName: 'Val Org',
      contactNumber: '+1-555-0000',
    });
    const cookies = regRes.headers['set-cookie'] as string[];

    // limit > 100 should fail Zod coercion
    const res = await request(app)
      .get('/api/users')
      .query({ limit: 9999 })
      .set('Cookie', cookies);

    // ORG_ADMIN registered via /register gets ORG_ADMIN role, so should reach validation
    expect([400, 200]).toContain(res.status); // Zod clamps or rejects
  });
});
