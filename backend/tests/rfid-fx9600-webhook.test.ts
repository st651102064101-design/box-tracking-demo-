import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { env } from '../src/env.js';
import { encodeBarcodeToEpcHex } from '../src/lib/rfid.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {
        'BOX-A': { tag: 'BOX-A', type: 'BT-001', value: 450, status: 'pending', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-B': { tag: 'BOX-B', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
      },
      customers: {},
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [5], gateTypes: { '5': 'both' } } },
      gates: { '5': 'WH-001' },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

const webhookUrl = (gate: number | string) => `/api/rfid/fx9600/${gate}/webhook`;
const secretHeader = { 'X-Webhook-Secret': env.fx9600WebhookSecret };

describe('POST /api/rfid/fx9600/:gate/webhook', () => {
  it('rejects a request with no secret header', async () => {
    const res = await request(ctx.app).post(webhookUrl(5)).send({ idHex: '00' });
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong secret', async () => {
    const res = await request(ctx.app)
      .post(webhookUrl(5))
      .set({ 'X-Webhook-Secret': 'not-the-secret' })
      .send({ idHex: '00' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-numeric gate', async () => {
    const res = await request(ctx.app).post(webhookUrl('north')).set(secretHeader).send({ idHex: '00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_gate');
  });

  it('receives a box in via a single-object payload carrying the ASCII-decoded barcode', async () => {
    const epcHex = encodeBarcodeToEpcHex('BOX-B');
    const res = await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ idHex: epcHex });
    expect(res.status).toBe(200);
    expect(res.body.received).toContain('BOX-B');

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.boxes['BOX-B'].status).toBe('warehouse');
  });

  it('receives multiple boxes via an array payload, and a bare-array "data" wrapper', async () => {
    const epcHex = encodeBarcodeToEpcHex('BOX-A');
    const res = await request(ctx.app)
      .post(webhookUrl(5))
      .set(secretHeader)
      .send({ data: { idHex: epcHex } });
    expect(res.status).toBe(200);
    expect(res.body.received).toContain('BOX-A');

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.boxes['BOX-A'].status).toBe('warehouse');
  });

  it('ignores a heartbeat/status payload with no tag data instead of erroring', async () => {
    const res = await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ status: 'ok' });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual([]);
  });
});
