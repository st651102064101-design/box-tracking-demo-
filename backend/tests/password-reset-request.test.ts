import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { bootstrap, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

describe('password reset request', () => {
  it('says plainly that the email is unknown and sends nothing to Firebase', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await request(ctx.app).post('/api/auth/password-reset/request').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('email_not_found');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects a malformed email without saying anything about accounts', async () => {
    const res = await request(ctx.app).post('/api/auth/password-reset/request').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});
