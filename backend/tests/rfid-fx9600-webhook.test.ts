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
      /* One box per test that expects a receive: the route suppresses repeat
         reads of the same tag for a minute (see FX9600_REPEAT_SUPPRESS_MS),
         so tests sharing a box would have the second one silently suppressed
         depending on execution order. */
      boxes: {
        'BOX-A': { tag: 'BOX-A', type: 'BT-001', value: 450, status: 'pending', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-B': { tag: 'BOX-B', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-C': { tag: 'BOX-C', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-D': { tag: 'BOX-D', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-E': { tag: 'BOX-E', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
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

  it('accepts the secret via HTTP Basic auth password (FX9600 UI has no custom-header field)', async () => {
    const res = await request(ctx.app)
      .post(webhookUrl(5))
      .auth('fx9600', env.fx9600WebhookSecret)
      .send({ status: 'ok' });
    expect(res.status).toBe(200);
  });

  it('rejects HTTP Basic auth with the wrong password', async () => {
    const res = await request(ctx.app).post(webhookUrl(5)).auth('fx9600', 'nope').send({ idHex: '00' });
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

  it('receives a box from the real FX9600 INVENTORY payload shape (array of {data:{idHex}})', async () => {
    // Captured verbatim off a live FX9600 running IoT Connector in INVENTORY
    // mode — every element wraps the read one level down, which the old
    // top-level-only extraction missed, so real reports looked tagless.
    const epcHex = encodeBarcodeToEpcHex('BOX-D').toLowerCase();
    const res = await request(ctx.app)
      .post(webhookUrl(5))
      .set(secretHeader)
      .send([
        {
          data: { antenna: 1, eventNum: 2558, format: 'epc', idHex: 'e2801191a5030069565def45', peakRssi: -63, reads: 10 },
          timestamp: '2026-08-14T08:17:27.426+0000',
          type: 'INVENTORY',
        },
        {
          data: { antenna: 1, eventNum: 2559, format: 'epc', idHex: epcHex, peakRssi: -72, reads: 10 },
          timestamp: '2026-08-14T08:17:27.430+0000',
          type: 'INVENTORY',
        },
      ]);
    expect(res.status).toBe(200);
    expect(res.body.received).toContain('BOX-D');
    // The foreign tag is reported back as unknown rather than silently dropped.
    expect(res.body.unknown).toContain('e2801191a5030069565def45');
  });

  it('suppresses repeats so a stationary box is not re-received every report', async () => {
    const epcHex = encodeBarcodeToEpcHex('BOX-E').toLowerCase();
    const payload = [{ data: { idHex: epcHex }, type: 'INVENTORY' }];

    const first = await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send(payload);
    expect(first.body.received).toContain('BOX-E');

    // Same tag, immediately again — a fixed reader does this once a second.
    const second = await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send(payload);
    expect(second.body.received).toEqual([]);

    const log = await request(ctx.app).get('/api/rfid/fx9600/debug-log').set(auth(ctx.token));
    expect(log.body.entries[0].repeats).toContain('BOX-E');
  });

  it('receives a box even when the reader sends tag data with a non-JSON Content-Type', async () => {
    // Zebra's IoT Connector doesn't let you configure the Content-Type it
    // posts with, and express.json() silently leaves req.body empty for
    // anything it doesn't recognise — which downstream is indistinguishable
    // from "heartbeat with no tags". The route parses raw bytes itself now.
    const epcHex = encodeBarcodeToEpcHex('BOX-C');
    const res = await request(ctx.app)
      .post(webhookUrl(5))
      .set(secretHeader)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ idHex: epcHex }));
    expect(res.status).toBe(200);
    expect(res.body.received).toContain('BOX-C');
  });

  it('logs the raw body and Content-Type so a malformed payload is diagnosable', async () => {
    await request(ctx.app)
      .post(webhookUrl(5))
      .set(secretHeader)
      .set('Content-Type', 'application/octet-stream')
      .send('not json at all');

    const log = await request(ctx.app).get('/api/rfid/fx9600/debug-log').set(auth(ctx.token));
    const entry = log.body.entries[0];
    expect(entry.rawBody).toBe('not json at all');
    expect(entry.contentType).toContain('application/octet-stream');
    expect(entry.parseError).toBeTruthy();
  });

  it('records every accepted hit (heartbeats included) in the debug log for on-site troubleshooting', async () => {
    await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ status: 'ok' });
    const epcHex = encodeBarcodeToEpcHex('BOX-B');
    await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ idHex: epcHex });

    const log = await request(ctx.app).get('/api/rfid/fx9600/debug-log').set(auth(ctx.token));
    expect(log.status).toBe(200);
    expect(log.body.entries.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    expect(log.body.entries[0].epcs).toContain(epcHex);
    expect(log.body.entries[0].decoded).toContain('BOX-B');
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

  it('records the gate as "seen" on any valid hit, tag data or not, for the frontend status light', async () => {
    await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ status: 'ok' });
    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.gateWebhookLastSeen['5']).toBeTruthy();
    expect(new Date(state.body.gateWebhookLastSeen['5']).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('does not record a gate on a rejected (bad-secret) request', async () => {
    const res = await request(ctx.app)
      .post(webhookUrl(6))
      .set({ 'X-Webhook-Secret': 'not-the-secret' })
      .send({ idHex: '00' });
    expect(res.status).toBe(401);
    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.gateWebhookLastSeen['6']).toBeUndefined();
  });
});
