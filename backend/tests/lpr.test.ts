import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { bootstrap, type TestCtx } from './helpers.js';
import { recordRfidObservation } from '../src/routes/lpr.js';
import { getDb } from '../src/db/client.js';
import { boxes, boxTypes, gates, rfidGateAutoSessions, vehicles, warehouses } from '../src/db/schema.js';
import { env } from '../src/env.js';

let ctx: TestCtx;
let seq = 0;

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  await db.insert(warehouses).values({ id: 'WH-L', name: 'LPR WH', gateType: 'in', data: {} });
  await db.insert(gates).values([1, 2, 3, 4, 5, 6, 7, 8].map((gateNo) => ({ gateNo, warehouseId: 'WH-L' })));
  await db.insert(boxTypes).values({ id: 'BT-L', name: 'LPR box' });
  // LPR-A last travelled on truck 70-1111; LPR-B has no truck on record.
  await db.insert(boxes).values([
    { tag: 'LPR-A', type: 'BT-L', status: 'out', data: { tag: 'LPR-A', plate: '70-1111' }, history: [] },
    { tag: 'LPR-B', type: 'BT-L', status: 'warehouse', data: { tag: 'LPR-B' }, history: [] },
  ]);
  await db.insert(vehicles).values({ id: 'V-1', data: { plate: '80-2222' } });
});

function detect(gateId: number, plateNumber: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return request(ctx.app)
    .post('/api/gate/lpr')
    .set('X-LPR-Webhook-Secret', env.lprWebhookSecret)
    .send({
      eventId: `evt-${seq}`, cameraId: 'CAM', plateNumber, confidence: 0.95, gateId,
      timestamp: new Date().toISOString(), vehicleColor: 'white', direction: 'inbound', ...extra,
    });
}

async function stage(gateNo: number, plate: string | null, expiresInMs = 60_000) {
  await getDb().insert(rfidGateAutoSessions).values({
    gateNo, direction: 'in', plate, expiresAt: new Date(Date.now() + expiresInMs),
  });
}

describe('POST /api/gate/lpr barrier decision', () => {
  it('does not open for an unregistered tag plus an unrelated plate', async () => {
    recordRfidObservation('GATE-1', ['DEADBEEF']);
    const res = await detect(1, 'XX-0000');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ action: 'manual_review', matchedRfid: false, reason: 'no_registered_rfid' });
  });

  it('does not open for a registered box with a plate nothing links to it', async () => {
    recordRfidObservation('GATE-2', ['LPR-A']);
    const res = await detect(2, 'XX-0000');
    expect(res.body).toMatchObject({ action: 'manual_review', matchedRfid: false, reason: 'plate_not_recognized' });
  });

  it('has no built-in mock shipment', async () => {
    const res = await detect(1, '1กข1234', { timestamp: new Date().toISOString() });
    expect(res.body.action).toBe('manual_review');
  });

  it('opens when the plate is the one recorded on the detected box', async () => {
    recordRfidObservation('GATE-3', ['LPR-A']);
    const res = await detect(3, '70-1111');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'open_gate', matchedRfid: true, reason: 'plate_and_rfid_matched' });
  });

  it('opens for a registered vehicle carrying a registered box', async () => {
    recordRfidObservation('GATE-4', ['LPR-B']);
    expect((await detect(4, '80-2222')).body.action).toBe('open_gate');
  });

  it('enforces the plate staged for the gate, even over a registered vehicle', async () => {
    await stage(5, '90-3333');
    recordRfidObservation('GATE-5', ['LPR-B']);
    expect((await detect(5, '80-2222')).body).toMatchObject({ action: 'manual_review', reason: 'plate_mismatch' });
    expect((await detect(5, '90-3333')).body.action).toBe('open_gate');
  });

  it('lets the camera supply the plate when an operator staged a session without one', async () => {
    await stage(6, null);
    recordRfidObservation('GATE-6', ['LPR-B']);
    expect((await detect(6, 'NEW-4444')).body.action).toBe('open_gate');
  });

  it('ignores an expired session', async () => {
    await stage(7, null, -1000);
    recordRfidObservation('GATE-7', ['LPR-B']);
    expect((await detect(7, 'NEW-4444')).body.action).toBe('manual_review');
  });

  it('reports low confidence as the reason, not a successful match', async () => {
    recordRfidObservation('GATE-8', ['LPR-B']);
    const res = await detect(8, '80-2222', { confidence: 0.5 });
    expect(res.body).toMatchObject({ action: 'manual_review', matchedRfid: true, reason: 'low_confidence' });
    await getDb().delete(rfidGateAutoSessions).where(eq(rfidGateAutoSessions.gateNo, 8));
  });
});
