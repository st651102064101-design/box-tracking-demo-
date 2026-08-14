import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

describe('GET/PUT /api/gate-prefs', () => {
  it('starts empty for an account that has never picked a gate', async () => {
    const res = await request(ctx.app).get('/api/gate-prefs').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ out: '', in: '' });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(ctx.app).get('/api/gate-prefs');
    expect(res.status).toBe(401);
  });

  it('persists a picked gate and returns it on the next GET (survives "reload")', async () => {
    const put = await request(ctx.app).put('/api/gate-prefs').set(auth(ctx.token)).send({ in: '5' });
    expect(put.status).toBe(200);

    const res = await request(ctx.app).get('/api/gate-prefs').set(auth(ctx.token));
    expect(res.body).toEqual({ out: '', in: '5' });
  });

  it('updating one direction does not clobber the other', async () => {
    await request(ctx.app).put('/api/gate-prefs').set(auth(ctx.token)).send({ out: '3' });

    const res = await request(ctx.app).get('/api/gate-prefs').set(auth(ctx.token));
    expect(res.body).toEqual({ out: '3', in: '5' });
  });
});
