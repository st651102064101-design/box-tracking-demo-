import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

describe('health + auth', () => {
  it('reports healthy', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('logs in the seeded admin', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.username).toBe('admin');
  });

  it('rejects bad credentials', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('registers a new user and returns a usable token', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ username: 'staff1', password: 'secret1', name: 'พนักงาน 1', email: 'staff1@example.com' });
    expect(res.status).toBe(201);
    const me = await request(ctx.app).get('/api/auth/me').set(auth(res.body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('staff1');
  });

  it('logs in with the account email instead of the username', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'staff1@example.com', password: 'secret1' });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('staff1');
  });

  it('email login is case-insensitive', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'STAFF1@EXAMPLE.COM', password: 'secret1' });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('staff1');
  });

  it('rejects registration without an email', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ username: 'staff2', password: 'secret1', name: 'พนักงาน 2' });
    expect(res.status).toBe(400);
  });

  it('forgot-password claims success without revealing whether a username exists', async () => {
    const res = await request(ctx.app).post('/api/auth/forgot-password').send({ username: 'no-such-user' });
    expect(res.status).toBe(200);
    expect(res.body.sentTo).toBeNull();
  });

  it('forgot-password fails clearly when SMTP is not configured (no email actually sent)', async () => {
    const res = await request(ctx.app).post('/api/auth/forgot-password').send({ username: 'staff1' });
    // Test env has no SMTP configured — sendMail() throws 503 rather than
    // silently pretending an email went out, which is the behavior worth
    // locking in here (see lib/mailer.ts).
    expect(res.status).toBe(503);
  });

  it('reset-password rejects a wrong OTP', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/reset-password')
      .send({ username: 'staff1', otp: '000000', password: 'newpass1' });
    expect(res.status).toBe(400);
  });

  it('blocks protected routes without a token', async () => {
    const res = await request(ctx.app).get('/api/state');
    expect(res.status).toBe(401);
  });
});
