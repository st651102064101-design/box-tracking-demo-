import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { OFFLINE_THRESHOLD_MS } from '../src/services/fx9600.js';
import { getDb } from '../src/db/client.js';
import { fx9600Readers } from '../src/db/schema.js';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await bootstrap();
});

describe('POST /api/fx9600/webhook', () => {
  it('rejects a call with no reader id', async () => {
    const res = await request(ctx.app).post('/api/fx9600/webhook').send({});
    expect(res.status).toBe(400);
  });

  it('records a heartbeat even with an empty "no read" payload, and it shows online', async () => {
    const webhook = await request(ctx.app).post('/api/fx9600/webhook?reader=GATE-1&gate=1').send({});
    expect(webhook.status).toBe(200);

    const status = await request(ctx.app).get('/api/fx9600/status').set(auth(ctx.token));
    expect(status.status).toBe(200);
    const reader = status.body.readers.find((r: { id: string }) => r.id === 'GATE-1');
    expect(reader).toMatchObject({ id: 'GATE-1', gateNo: 1, online: true });
  });

  it('flips to offline once the webhook has stopped arriving past the threshold', async () => {
    await request(ctx.app).post('/api/fx9600/webhook?reader=GATE-2').send({ tags: [] });
    let status = await request(ctx.app).get('/api/fx9600/status').set(auth(ctx.token));
    expect(status.body.readers.find((r: { id: string }) => r.id === 'GATE-2').online).toBe(true);

    // Simulate the webhook having gone quiet: backdate the stored heartbeat
    // rather than mocking Date.now(), since online/offline is derived from a
    // real DB timestamp compared against the real clock (see getReaderStatuses).
    await getDb()
      .update(fx9600Readers)
      .set({ lastWebhookAt: new Date(Date.now() - OFFLINE_THRESHOLD_MS - 1000) })
      .where(eq(fx9600Readers.id, 'GATE-2'));

    status = await request(ctx.app).get('/api/fx9600/status').set(auth(ctx.token));
    expect(status.body.readers.find((r: { id: string }) => r.id === 'GATE-2').online).toBe(false);
  });

  it('requires auth on GET /status', async () => {
    const res = await request(ctx.app).get('/api/fx9600/status');
    expect(res.status).toBe(401);
  });
});
