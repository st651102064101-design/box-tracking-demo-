import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { auth, bootstrap, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({
    boxes: {},
    customers: {},
    boxtypes: {},
    warehouses: { 'WH-001': { id: 'WH-001', name: 'คลังหลัก', gates: [1] } },
    gates: { '1': 'WH-001' },
    cfg: {},
  });
});

describe('POST /api/gate/lpr', () => {
  it('accepts a camera JSON event without an operator JWT and emits a state update', async () => {
    const response = await request(ctx.app).post('/api/gate/lpr').send({
      eventId: 'lpr-test-001',
      cameraId: 'LPR-1',
      cameraIp: '192.168.1.80',
      plateNumber: 'กข-1234',
      confidence: 98.5,
      gateId: '1',
      timestamp: '2026-09-23T07:00:00.000Z',
    });
    expect(response.status).toBe(202);
    expect(response.body.received).toBe(true);
    expect(response.body.cameraIp).toBe('192.168.1.80');

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.events.some((event: Record<string, unknown>) => event.eventId === 'lpr-test-001')).toBe(true);
  });

  it('rejects malformed/missing plate data and gates that do not exist', async () => {
    const noPlate = await request(ctx.app).post('/api/gate/lpr').send({ gateId: 1 });
    expect(noPlate.status).toBe(400);

    const unknownGate = await request(ctx.app).post('/api/gate/lpr').send({ plateNumber: 'กข-1234', gateId: 999 });
    expect(unknownGate.status).toBe(404);
  });
});
