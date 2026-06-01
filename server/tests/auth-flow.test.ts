import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

const TEST_USER = {
  name: 'Auth Test',
  email: 'authtest@example.com',
  password: 'TestPassword1!',
  organizationName: 'Auth Test Org',
};

describe('Auth flow', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('registers successfully and returns HttpOnly cookies', async () => {
    const res = await request(app).post('/api/auth/register').send(TEST_USER);
    expect(res.status).toBe(201);
    const cookies = res.headers['set-cookie'] as string[];
    expect(cookies.some((c: string) => c.startsWith('accessToken='))).toBe(true);
    expect(cookies.some((c: string) => c.includes('HttpOnly'))).toBe(true);
  });

  it('rejects login with wrong password', async () => {
    await request(app).post('/api/auth/register').send(TEST_USER);
    const res = await request(app).post('/api/auth/login').send({ email: TEST_USER.email, password: 'WrongPass1!' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects requests with no token', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('rotates refresh token on each use', async () => {
    await request(app).post('/api/auth/register').send(TEST_USER);
    const loginRes = await request(app).post('/api/auth/login').send({ email: TEST_USER.email, password: TEST_USER.password });
    const cookies1 = loginRes.headers['set-cookie'] as string[];

    const refresh1 = await request(app).post('/api/auth/refresh').set('Cookie', cookies1);
    expect(refresh1.status).toBe(200);
    const cookies2 = refresh1.headers['set-cookie'] as string[];

    // Old refresh token must be invalid now
    const refresh2 = await request(app).post('/api/auth/refresh').set('Cookie', cookies1);
    expect(refresh2.status).toBe(401);

    // New refresh token must work
    const refresh3 = await request(app).post('/api/auth/refresh').set('Cookie', cookies2);
    expect(refresh3.status).toBe(200);
  });

  it('rejects weak passwords at registration', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...TEST_USER,
      email: 'weak@example.com',
      password: 'weakpassword',
    });
    expect(res.status).toBe(400);
  });
});
