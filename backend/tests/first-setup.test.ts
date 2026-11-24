import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

/* The root page and /onboarding both read firstSetupRequired from /auth/me.
   It used to be missing there (it only came back from /auth/login), so
   /onboarding bounced straight back to "/" and first-time setup was never
   enforced. */
describe('GET /api/auth/me — firstSetupRequired', () => {
  it('is true while the account still has to change its default credentials', async () => {
    await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.username, 'admin'));
    const res = await request(ctx.app).get('/api/auth/me').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.user.firstSetupRequired).toBe(true);
  });

  it('is false once setup is done, using the same token', async () => {
    await getDb().update(users).set({ mustChangePassword: false }).where(eq(users.username, 'admin'));
    const res = await request(ctx.app).get('/api/auth/me').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.user.firstSetupRequired).toBe(false);
  });

  it('keeps returning the JWT claims and permissions', async () => {
    const res = await request(ctx.app).get('/api/auth/me').set(auth(ctx.token));
    expect(res.body.user.username).toBe('admin');
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });

  it('still rejects requests without a token', async () => {
    const res = await request(ctx.app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
