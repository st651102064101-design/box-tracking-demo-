import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { env } from '../src/env.js';
import { encodeBarcodeToEpcHex } from '../src/lib/rfid.js';
import { subscribeReaderStatus, type ReaderStatusEvent } from '../src/lib/bus.js';

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
        'BOX-F': { tag: 'BOX-F', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-G': { tag: 'BOX-G', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-H': { tag: 'BOX-H', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-I': { tag: 'BOX-I', type: 'BT-001', value: 450, status: 'warehouse', cycles: 1, labeled: true, history: [], location: {} },
        'BOX-J': { tag: 'BOX-J', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: true, history: [], location: {} },
        'BOX-K': { tag: 'BOX-K', type: 'BT-001', value: 450, status: 'out', cycles: 0, labeled: true, history: [], location: {} },
      },
      customers: {},
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [5, 6], gateTypes: { '5': 'in', '6': 'out' } } },
      gates: { '5': 'WH-001', '6': 'WH-001' },
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

  it('queues a box for confirmation rather than receiving it outright', async () => {
    const epcHex = encodeBarcodeToEpcHex('BOX-B');
    const res = await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ idHex: epcHex });
    expect(res.status).toBe(200);
    expect(res.body.received).toContain('BOX-B');

    // Queued, not booked in — a fixed reader sees boxes that never actually
    // arrive, so the operator confirms before anything changes status.
    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.boxes['BOX-B'].status).toBe('out');

    const pending = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    expect(pending.body.tags).toContain('BOX-B');
  });

  it('drops a tag from the queue on request, and lets the reader re-queue it after', async () => {
    const epcHex = encodeBarcodeToEpcHex('BOX-F');
    await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ idHex: epcHex });

    await request(ctx.app).delete('/api/rfid/pending/5/BOX-F').set(auth(ctx.token));
    let pending = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    expect(pending.body.tags).not.toContain('BOX-F');

    // Removing it also clears the repeat-suppression memory, or the box could
    // not be re-presented until the window lapsed.
    await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ idHex: epcHex });
    pending = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    expect(pending.body.tags).toContain('BOX-F');
  });

  it('clears only the named tags when the operator confirms a receive', async () => {
    await request(ctx.app)
      .post(webhookUrl(5))
      .set(secretHeader)
      .send([{ data: { idHex: encodeBarcodeToEpcHex('BOX-G') } }, { data: { idHex: encodeBarcodeToEpcHex('BOX-H') } }]);

    await request(ctx.app).delete('/api/rfid/pending/5').set(auth(ctx.token)).send({ tags: ['BOX-G'] });
    const pending = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    expect(pending.body.tags).not.toContain('BOX-G');
    expect(pending.body.tags).toContain('BOX-H');
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
    // The foreign tag is reported back as unknown rather than silently dropped,
    // and must NOT reach the queue — a gate has a dozen strangers' tags in
    // range and listing them as chips would bury the real boxes.
    expect(res.body.unknown).toContain('e2801191a5030069565def45');
    const pending = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    expect(pending.body.tags).toContain('BOX-D');
    expect(pending.body.tags).not.toContain('e2801191a5030069565def45');
  });

  it('suppresses repeats so a stationary box is not re-queued every report', async () => {
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

  it('queues a box that is already in the warehouse so Gate Out can confirm it', async () => {
    // BOX-I starts in the warehouse. Inbound ignores it in its UI, but the
    // shared physical RFID queue must retain it for an outbound gate.
    const res = await request(ctx.app)
      .post(webhookUrl(5))
      .set(secretHeader)
      .send({ idHex: encodeBarcodeToEpcHex('BOX-I') });
    expect(res.status).toBe(200);

    const pending = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    expect(pending.body.tags).toContain('BOX-I');
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

    const pending = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    expect(pending.body.tags).toContain('BOX-A');
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

  it('broadcasts an immediate online reader-status event for every accepted heartbeat', async () => {
    let event: ReaderStatusEvent | null = null;
    const unsubscribe = subscribeReaderStatus((next) => { event = next; });
    try {
      const res = await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send({ status: 'ok' });
      expect(res.status).toBe(200);
    } finally {
      unsubscribe();
    }
    expect(event).not.toBeNull();
    expect(event?.gate).toBe(5);
    expect(event?.online).toBe(true);
    expect(new Date(event?.lastActiveAt ?? 0).getTime()).toBeGreaterThan(Date.now() - 10_000);
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

describe('FX9600 reader-to-gate binding', () => {
  const payload = (gateNo: number) => ({
    name: `FX9600 Gate ${gateNo}`,
    host: `192.168.1.${gateNo}`,
    gateNo,
    webhookUrl: `http://192.168.1.2:4000/api/rfid/fx9600/${gateNo}/webhook`,
    transmitPower: 3,
    antennaCount: 1,
    heartbeatIntervalSeconds: 1,
  });

  it('prevents two reader records from being bound to the same gate', async () => {
    const first = await request(ctx.app).put('/api/rfid/fx9600/readers/fx-gate-5').set(auth(ctx.token)).send(payload(5));
    expect(first.status).toBe(200);

    const duplicate = await request(ctx.app).put('/api/rfid/fx9600/readers/fx-gate-5b').set(auth(ctx.token)).send(payload(5));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('gate_reader_already_bound');
  });

  it('routes one webhook payload to gates using the database antenna mapping', async () => {
    const configured = await request(ctx.app)
      .put('/api/rfid/fx9600/readers/fx-gate-5/antenna-mappings')
      .set(auth(ctx.token))
      .send({ mappings: [
        { antennaPort: 1, gateNo: 5 },
        { antennaPort: 2, gateNo: 5 },
        { antennaPort: 3, gateNo: 5 },
        { antennaPort: 4, gateNo: 6 },
      ] });
    expect(configured.status).toBe(200);

    const webhook = await request(ctx.app).post(webhookUrl(5)).set(secretHeader).send([
      { data: { antennaPort: 1, idHex: encodeBarcodeToEpcHex('BOX-J') } },
      { data: { antenna: 4, idHex: encodeBarcodeToEpcHex('BOX-K') } },
    ]);
    expect(webhook.status).toBe(200);
    expect(webhook.body.routed['5'].received).toContain('BOX-J');
    expect(webhook.body.routed['6'].received).toContain('BOX-K');

    const gate5 = await request(ctx.app).get('/api/rfid/pending/5').set(auth(ctx.token));
    const gate6 = await request(ctx.app).get('/api/rfid/pending/6').set(auth(ctx.token));
    expect(gate5.body.tags).toContain('BOX-J');
    expect(gate5.body.tags).not.toContain('BOX-K');
    expect(gate6.body.tags).toContain('BOX-K');
    expect(gate6.body.tags).not.toContain('BOX-J');
  });

  it('unbinding removes only the WMS reader mapping', async () => {
    const deleted = await request(ctx.app).delete('/api/rfid/fx9600/readers/fx-gate-5').set(auth(ctx.token));
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ ok: true, id: 'fx-gate-5', gateNo: 5 });

    const list = await request(ctx.app).get('/api/rfid/fx9600/readers').set(auth(ctx.token));
    expect(list.status).toBe(200);
    expect(list.body.readers.find((reader: { id: string }) => reader.id === 'fx-gate-5')).toBeUndefined();
  });
});
