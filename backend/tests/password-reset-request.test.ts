import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { bootstrap, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

describe('password reset request', () => {
  it('answers the same way for an unknown email and sends nothing to Firebase', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await request(ctx.app).post('/api/auth/password-reset/request').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('ถ้ามีบัญชี');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects a malformed email without saying anything about accounts', async () => {
    const res = await request(ctx.app).post('/api/auth/password-reset/request').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});
