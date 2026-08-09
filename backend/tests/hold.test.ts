import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {
        'WH-1': {
          tag: 'WH-1',
          type: 'BT-001',
          status: 'warehouse',
          labeled: true,
          location: { wh: 'WH-001', zone: 'A', rack: '1', shelf: '1', slot: '' },
          history: [],
        },
        'OUT-1': {
          tag: 'OUT-1',
          type: 'BT-001',
          status: 'out',
          labeled: true,
          location: {},
          history: [],
        },
        'PENDING-1': {
          tag: 'PENDING-1',
          type: 'BT-001',
          status: 'pending',
          labeled: false,
          location: {},
          history: [],
        },
      },
      customers: {},
      boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', value: 450 } },
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [1], gateTypes: { '1': 'both' } } },
      gates: { '1': 'WH-001' },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

/**
 * Covers the PDA's "Hold/Release" screen — the only way to hold/damage/
 * release a box any time other than at Gate In receiving (see the
 * gate-in-location tests for that path's own condition flags).
 */
describe('POST /api/boxes/:tag/hold', () => {
  it('holds a warehoused box, with a reason logged to history', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/WH-1/hold')
      .set(auth(ctx.token))
      .send({ status: 'hold', reason: 'รอตรวจสอบ QC' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('hold');
    const last = res.body.history.at(-1);
    expect(last).toMatchObject({ dir: 'hold', reason: 'รอตรวจสอบ QC' });

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.boxes['WH-1'].status).toBe('hold');
  });

  it('flags damage the same way, with its own history dir', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/WH-1/hold')
      .set(auth(ctx.token))
      .send({ status: 'damage', reason: 'มุมยุบ' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('damage');
    expect(res.body.history.at(-1)).toMatchObject({ dir: 'damage', reason: 'มุมยุบ' });
  });

  it('releases a held box back to warehouse, logged as dir "release"', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/WH-1/hold')
      .set(auth(ctx.token))
      .send({ status: 'warehouse' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('warehouse');
    expect(res.body.history.at(-1)).toMatchObject({ dir: 'release' });
  });

  it('rejects setting the same status twice in a row', async () => {
    await request(ctx.app).post('/api/boxes/WH-1/hold').set(auth(ctx.token)).send({ status: 'hold' });
    const res = await request(ctx.app).post('/api/boxes/WH-1/hold').set(auth(ctx.token)).send({ status: 'hold' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('status_unchanged');
    // clean up for the tests below
    await request(ctx.app).post('/api/boxes/WH-1/hold').set(auth(ctx.token)).send({ status: 'warehouse' });
  });

  it('refuses to hold a box that already shipped out', async () => {
    const res = await request(ctx.app).post('/api/boxes/OUT-1/hold').set(auth(ctx.token)).send({ status: 'hold' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('box_not_in_warehouse');
  });

  it('refuses to hold a box that has not been received yet', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/PENDING-1/hold')
      .set(auth(ctx.token))
      .send({ status: 'hold' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('box_not_in_warehouse');
  });

  it('404s on an unknown box', async () => {
    const res = await request(ctx.app).post('/api/boxes/NOPE/hold').set(auth(ctx.token)).send({ status: 'hold' });
    expect(res.status).toBe(404);
  });

  it('rejects an unrecognized status value', async () => {
    const res = await request(ctx.app).post('/api/boxes/WH-1/hold').set(auth(ctx.token)).send({ status: 'lost' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });
});
