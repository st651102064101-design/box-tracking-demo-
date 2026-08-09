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
      },
      customers: {},
      boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', value: 450 } },
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [1], gateTypes: { '1': 'both' } } },
      gates: { '1': 'WH-001' },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

/** Covers the PDA's floor-exception buttons: "ของหาย" / "ช่องเก็บเต็ม". */
describe('POST /api/reports', () => {
  it('records a missing-box report on the box history and the global feed', async () => {
    const res = await request(ctx.app)
      .post('/api/reports')
      .set(auth(ctx.token))
      .send({ kind: 'missing', tag: 'WH-1', note: 'ระบบสั่งมาเก็บช่องนี้แต่ไม่พบของ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dir: 'missing', tag: 'WH-1' });

    const box = await request(ctx.app).get('/api/boxes/WH-1').set(auth(ctx.token));
    expect(box.body.history.at(-1)).toMatchObject({ dir: 'missing', tag: 'WH-1' });
    // Reporting is observation, never a data correction — see the route's
    // own doc comment. Status must stay untouched.
    expect(box.body.status).toBe('warehouse');

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.events.some((e: { dir: string; tag: string }) => e.dir === 'missing' && e.tag === 'WH-1')).toBe(
      true,
    );
  });

  it('records a bin-full report against a location with no box tag at all', async () => {
    const res = await request(ctx.app)
      .post('/api/reports')
      .set(auth(ctx.token))
      .send({ kind: 'bin_full', location: { wh: 'WH-001', zone: 'A', rack: '2', shelf: '1' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dir: 'bin_full', tag: null });
    expect(res.body.location).toMatchObject({ zone: 'A', rack: '2' });
  });

  it('404s a missing-box report against an unknown tag', async () => {
    const res = await request(ctx.app).post('/api/reports').set(auth(ctx.token)).send({ kind: 'missing', tag: 'NOPE' });
    expect(res.status).toBe(404);
  });

  it('rejects a report with neither a tag nor a location', async () => {
    const res = await request(ctx.app).post('/api/reports').set(auth(ctx.token)).send({ kind: 'missing' });
    expect(res.status).toBe(400);
  });
});
