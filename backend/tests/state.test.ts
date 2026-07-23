import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

/** A representative slice of the legacy `S` object, including nested bits. */
const sampleState = {
  boxes: {
    'BTX-2601-ABCDE': {
      tag: 'BTX-2601-ABCDE',
      type: 'BT-001',
      value: 450,
      status: 'out',
      cycles: 3,
      customer: 'CUST-001',
      do: 'DO-0001',
      po: 'PO-777',
      outGate: 2,
      outWh: 'WH-001',
      outAt: '2026-07-20T03:00:00.000Z',
      dueAt: '2026-08-04T03:00:00.000Z',
      dueDate: '04/08/2026',
      returnDays: 15,
      lastSeenAt: '2026-07-20T03:00:00.000Z',
      labeled: true,
      location: { wh: 'WH-001', zone: 'A', rack: '1', shelf: '2', slot: '3', gate: 2, ts: '2026-07-20T03:00:00.000Z' },
      history: [
        { dir: 'in', ts: '2026-07-01T02:00:00.000Z', gate: 1, wh: 'WH-001', recorder: 'demo' },
        { dir: 'out', ts: '2026-07-20T03:00:00.000Z', do: 'DO-0001', customer: 'CUST-001', gate: 2, wh: 'WH-001' },
      ],
    },
  },
  customers: { 'CUST-001': { id: 'CUST-001', name: 'ลูกค้า ก', addr: 'กรุงเทพฯ', contact: '02-000-0000', returnDays: 15 } },
  boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', unit: 'ใบ', value: 450, dim: '60x40x30' } },
  warehouses: { 'WH-001': { id: 'WH-001', name: 'คลังหลัก', gateType: 'both', gates: [1, 2, 3], gateTypes: { '1': 'in', '2': 'out', '3': 'both' } } },
  gates: { '1': 'WH-001', '2': 'WH-001', '3': 'WH-001' },
  locations: { 'A-1-2-3': { code: 'A-1-2-3', wh: 'WH-001', zone: 'A', rack: '1', shelf: '2', slot: '3', type: 'shelf', note: '' } },
  employees: { 'EMP-001': { id: 'EMP-001', name: 'demo', role: 'admin' } },
  events: [
    { ts: '2026-07-01T02:00:00.000Z', dir: 'in', tag: 'BTX-2601-ABCDE', gate: 1, wh: 'WH-001', recorder: 'demo' },
    { ts: '2026-07-20T03:00:00.000Z', dir: 'out', tag: 'BTX-2601-ABCDE', do: 'DO-0001', customer: 'CUST-001', gate: 2, wh: 'WH-001', recorder: 'demo' },
  ],
  doRecords: { 'DO-0001': { customer: 'CUST-001', po: 'PO-777', returnDays: 15 } },
  vehicles: { '1กก-1234': { plate: '1กก-1234', driver: 'สมชาย' } },
  putaway: {},
  inventory: {},
  cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
  seq: { do: 1, emp: 1 },
  auditLog: [
    { ts: '2026-07-20T03:00:00.000Z', action: 'CREATE', recorder: 'demo', itemId: 'CUST-001', itemName: 'ลูกค้า ก', before: '', after: '{}' },
  ],
};

describe('state bridge (S ↔ Postgres)', () => {
  it('round-trips the full state losslessly', async () => {
    const put = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(sampleState);
    expect(put.status).toBe(200);

    const get = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(get.status).toBe(200);
    const s = get.body;

    // maps preserved verbatim
    expect(s.boxes['BTX-2601-ABCDE']).toEqual(sampleState.boxes['BTX-2601-ABCDE']);
    expect(s.customers['CUST-001']).toEqual(sampleState.customers['CUST-001']);
    expect(s.boxtypes['BT-001']).toEqual(sampleState.boxtypes['BT-001']);
    expect(s.warehouses['WH-001']).toEqual(sampleState.warehouses['WH-001']);
    expect(s.locations['A-1-2-3']).toEqual(sampleState.locations['A-1-2-3']);
    expect(s.doRecords['DO-0001']).toEqual(sampleState.doRecords['DO-0001']);

    // gates lookup
    expect(s.gates).toEqual(sampleState.gates);

    // ordered arrays
    expect(s.events).toEqual(sampleState.events);
    expect(s.auditLog).toEqual(sampleState.auditLog);

    // singletons
    expect(s.cfg).toEqual(sampleState.cfg);
    expect(s.seq).toEqual(sampleState.seq);
  });

  it('replaces (not merges) on subsequent PUT', async () => {
    await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({ boxes: {}, customers: {} });
    const get = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(Object.keys(get.body.boxes)).toHaveLength(0);
    expect(Object.keys(get.body.customers)).toHaveLength(0);
  });
});
