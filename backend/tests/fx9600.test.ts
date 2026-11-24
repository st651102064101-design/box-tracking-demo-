import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { OFFLINE_THRESHOLD_MS } from '../src/services/fx9600.js';
import { getDb } from '../src/db/client.js';
import { fx9600Readers } from '../src/db/schema.js';
import { env } from '../src/env.js';

let ctx: TestCtx;

/* The reader is firmware and cannot hold a JWT, so POST /webhook is gated by the
   same shared secret as the reader's other webhook (/api/rfid/fx9600/:gate/webhook). */
const secret = { 'X-Webhook-Secret': env.fx9600WebhookSecret };

beforeAll(async () => {
  ctx = await bootstrap();
});

describe('POST /api/fx9600/webhook', () => {
  it('rejects a call with no reader id', async () => {
    const res = await request(ctx.app).post('/api/fx9600/webhook').set(secret).send({});
    expect(res.status).toBe(400);
  });

  it('records a heartbeat even with an empty "no read" payload, and it shows online', async () => {
    const webhook = await request(ctx.app).post('/api/fx9600/webhook?reader=GATE-1&gate=1').set(secret).send({});
    expect(webhook.status).toBe(200);

    const status = await request(ctx.app).get('/api/fx9600/status').set(auth(ctx.token));
    expect(status.status).toBe(200);
    const reader = status.body.readers.find((r: { id: string }) => r.id === 'GATE-1');
    expect(reader).toMatchObject({ id: 'GATE-1', gateNo: 1, online: true });
  });

  it('flips to offline once the webhook has stopped arriving past the threshold', async () => {
    await request(ctx.app).post('/api/fx9600/webhook?reader=GATE-2').set(secret).send({ tags: [] });
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

  it('rejects a webhook with no secret or the wrong one, and records nothing', async () => {
    const none = await request(ctx.app).post('/api/fx9600/webhook?reader=SPOOF-1').send({});
    expect(none.status).toBe(401);
    const wrong = await request(ctx.app)
      .post('/api/fx9600/webhook?reader=SPOOF-1')
      .set('X-Webhook-Secret', 'not-the-secret')
      .send({});
    expect(wrong.status).toBe(401);

    const status = await request(ctx.app).get('/api/fx9600/status').set(auth(ctx.token));
    expect(status.body.readers.find((r: { id: string }) => r.id === 'SPOOF-1')).toBeUndefined();
  });

  it('accepts the secret as the password of a Basic Authorization header', async () => {
    const basic = 'Basic ' + Buffer.from(`reader:${env.fx9600WebhookSecret}`).toString('base64');
    const res = await request(ctx.app)
      .post('/api/fx9600/webhook?reader=GATE-3')
      .set('Authorization', basic)
      .send({});
    expect(res.status).toBe(200);
  });

  it('requires auth on GET /status', async () => {
    const res = await request(ctx.app).get('/api/fx9600/status');
    expect(res.status).toBe(401);
  });
});
