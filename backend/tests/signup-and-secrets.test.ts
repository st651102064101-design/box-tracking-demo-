import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { weakSecretReason, weakAdminPassword } from '../src/lib/secrets.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

const account = (username: string) => ({ username, password: 'secret-123', name: username, email: `${username}@example.com` });

describe('POST /api/auth/register is not open signup', () => {
  it('refuses a caller who is not signed in', async () => {
    const res = await request(ctx.app).post('/api/auth/register').send(account('anon1'));
    expect(res.status).toBe(401);
    const login = await request(ctx.app).post('/api/auth/login').send({ username: 'anon1', password: 'secret-123' });
    expect(login.status).toBe(401);
  });

  it('lets an administrator create an account, but not that account create more', async () => {
    const made = await request(ctx.app).post('/api/auth/register').set(auth(ctx.token)).send(account('staff9'));
    expect(made.status).toBe(201);
    const again = await request(ctx.app).post('/api/auth/register').set(auth(made.body.token)).send(account('staff10'));
    expect(again.status).toBe(403);
  });
});

describe('production secret check', () => {
  it.each([
    undefined, '', 'change-me-in-production', 'change-me-in-production-please-use-a-long-random-string',
    'BoxTrace-LPR-2026', 'dev-insecure-secret-change-me', 'short',
  ])('refuses %s', (value) => {
    expect(weakSecretReason(value, 16)).not.toBeNull();
  });
  it('accepts a long random value', () => {
    expect(weakSecretReason('9f2c4b7a1d8e3f60a5b9c2d7e4f1a8b3', 32)).toBeNull();
  });
  it('refuses guessable first-admin passwords', () => {
    expect(weakAdminPassword('admin123')).toBe(true);
    expect(weakAdminPassword('abc')).toBe(true);
    expect(weakAdminPassword('Vq7!mTz2#Lp9')).toBe(false);
  });
});
