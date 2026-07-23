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
      .send({ username: 'staff1', password: 'secret1', name: 'พนักงาน 1' });
    expect(res.status).toBe(201);
    const me = await request(ctx.app).get('/api/auth/me').set(auth(res.body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('staff1');
  });

  it('blocks protected routes without a token', async () => {
    const res = await request(ctx.app).get('/api/state');
    expect(res.status).toBe(401);
  });
});
