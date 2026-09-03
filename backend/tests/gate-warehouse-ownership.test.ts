import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;

/** Two warehouses, one box sitting in each — covers the "a box scanned at
 *  this gate must belong to this gate's own warehouse" rule in both
 *  directions (gate/out and gate/in). Isolated in its own file/DB rather
 *  than added to gate.test.ts's shared single-warehouse seed, since a
 *  second warehouse+gate can only be added via a wholesale PUT /api/state,
 *  which would clobber every other test in that file. */
beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {
        // Sitting in WH-1, shelved (has a real location).
        'WH1-A': {
          tag: 'WH1-A', type: 'BT-001', status: 'warehouse', cycles: 0, labeled: true,
          history: [{ dir: 'in-new', ts: '2026-01-01T00:00:00.000Z', wh: 'WH-1' }],
          location: { wh: 'WH-1', zone: 'A', rack: '1', shelf: '1', slot: '' },
        },
        // Sitting in WH-1 too, but via "รอ Putaway" (deferred) — no location
        // stamped at all, only its receiving history says where it landed.
        'WH1-B': {
          tag: 'WH1-B', type: 'BT-001', status: 'warehouse', cycles: 0, labeled: true,
          history: [{ dir: 'in-new', ts: '2026-01-01T00:00:00.000Z', wh: 'WH-1' }],
          location: {},
        },
        // Sitting in WH-2.
        'WH2-A': {
          tag: 'WH2-A', type: 'BT-001', status: 'warehouse', cycles: 0, labeled: true,
          history: [{ dir: 'in-new', ts: '2026-01-01T00:00:00.000Z', wh: 'WH-2' }],
          location: { wh: 'WH-2', zone: 'A', rack: '1', shelf: '1', slot: '' },
        },
        // Shipped out of WH-2, ready to test a wrong-warehouse gate/in.
        'WH2-OUT': {
          tag: 'WH2-OUT', type: 'BT-001', status: 'out', cycles: 0, labeled: true,
          history: [{ dir: 'in-new', ts: '2026-01-01T00:00:00.000Z', wh: 'WH-2' }],
          location: {}, outWh: 'WH-2', customer: 'CUST-001',
        },
        // Shipped out of WH-2 but still carrying WH-2's shelf position —
        // receiving it at WH-1 has to re-home it, not keep the stale location.
        'WH2-OUT2': {
          tag: 'WH2-OUT2', type: 'BT-001', status: 'out', cycles: 0, labeled: true,
          history: [{ dir: 'in-new', ts: '2026-01-01T00:00:00.000Z', wh: 'WH-2' }],
          location: { wh: 'WH-2', zone: 'A', rack: '1', shelf: '2', slot: '' }, outWh: 'WH-2', customer: 'CUST-001',
        },
        // Brand new from a supplier — no outWh, never received anywhere yet.
        'NEW-1': { tag: 'NEW-1', type: 'BT-001', status: 'pending', labeled: true, history: [], location: {} },
      },
      customers: { 'CUST-001': { id: 'CUST-001', name: 'ลูกค้า ก', returnDays: 10 } },
      boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', value: 450 } },
      warehouses: {
        'WH-1': { id: 'WH-1', name: 'คลัง 1', gates: [1], gateTypes: { '1': 'both' } },
        'WH-2': { id: 'WH-2', name: 'คลัง 2', gates: [2], gateTypes: { '2': 'both' } },
      },
      gates: { '1': 'WH-1', '2': 'WH-2' },
      employees: {
        'EMP-0001': { id: 'EMP-0001', name: 'สมชาย ใจดี', role: 'พนักงานคลัง', access: 'operator', status: 'active' },
      },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

describe('gate warehouse ownership', () => {
  it('refuses to ship a box at a gate belonging to another warehouse', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['WH2-A'], customer: 'CUST-001', gate: 1 }); // gate 1 = WH-1, box is WH-2's
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('box_wrong_warehouse');

    const box = await request(ctx.app).get('/api/boxes/WH2-A').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse'); // untouched
  });

  it('ships a box out fine at its own warehouse gate', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['WH1-A'], customer: 'CUST-001', gate: 1 });
    expect(res.status).toBe(200);
  });

  it('ships a "รอ Putaway" box (no location, only history) out fine at its own warehouse gate', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['WH1-B'], customer: 'CUST-001', gate: 1 });
    expect(res.status).toBe(200);
  });

  it('receives a box shipped from another warehouse — an inter-warehouse transfer', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['WH2-OUT2'], gate: 1 }); // gate 1 = WH-1, box shipped from WH-2
    expect(res.status).toBe(200);

    const box = await request(ctx.app).get('/api/boxes/WH2-OUT2').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    // Re-homed onto WH-1 with no position — WH-2's rack didn't travel with it.
    expect(box.body.location.wh).toBe('WH-1');
    expect(box.body.location.rack).toBe('');

    // ...and it can now ship straight back out of the warehouse it's in.
    const out = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['WH2-OUT2'], customer: 'CUST-001', gate: 1 });
    expect(out.status).toBe(200);
  });

  it('receives a returning box fine at its own warehouse gate', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['WH2-OUT'], gate: 2 });
    expect(res.status).toBe(200);
  });

  it('receives a brand-new box from a supplier at any gate, no warehouse restriction', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['NEW-1'], gate: 1 });
    expect(res.status).toBe(200);
  });
});
