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
  dfPrefs: { demo: { ovMove: { mode: 'day', day: 7, month: 1, year: 1, from: '', to: '' } } },
  uiPrefs: { demo: { theme: 'dark', filtBoxStatus: 'warehouse' } },
  gatePrefs: { demo: { lastGate: 2 } },
  auditLog: [
    // PUT /api/state only accepts client audit entries newer than the server's
    // start time (AUDIT_CACHE_CUTOFF in services/state.ts) so a stale browser
    // cache can never resurrect rows after the audit log was cleared — hence a
    // timestamp taken now rather than a fixed past date.
    { ts: new Date(Date.now() + 60_000).toISOString(), action: 'CREATE', recorder: 'demo', itemId: 'CUST-001', itemName: 'ลูกค้า ก', before: '', after: '{}' },
  ],
};

describe('state bridge (S ↔ Postgres)', () => {
  it('round-trips the full state losslessly', async () => {
    const put = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(sampleState);
    expect(put.status).toBe(200);

    const get = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(get.status).toBe(200);
    const s = get.body;

    // maps preserved verbatim. Boxes additionally carry the derived 3D slot
    // geometry (slotId/widthCm/…), which composeState adds on top of the
    // snapshot, so every field the client sent must come back unchanged but
    // extra derived fields are allowed.
    expect(s.boxes['BTX-2601-ABCDE']).toMatchObject(sampleState.boxes['BTX-2601-ABCDE']);
    expect(s.boxes['BTX-2601-ABCDE'].slotId).toBe('A-1-2-3');
    expect(s.customers['CUST-001']).toMatchObject(sampleState.customers['CUST-001']);
    expect(s.boxtypes['BT-001']).toMatchObject(sampleState.boxtypes['BT-001']);
    expect(s.warehouses['WH-001']).toMatchObject(sampleState.warehouses['WH-001']);
    expect(s.locations['A-1-2-3']).toMatchObject(sampleState.locations['A-1-2-3']);
    expect(s.doRecords['DO-0001']).toMatchObject(sampleState.doRecords['DO-0001']);

    // gates lookup
    expect(s.gates).toEqual(sampleState.gates);

    // ordered arrays
    expect(s.events).toEqual(sampleState.events);
    expect(s.auditLog).toEqual(sampleState.auditLog);

    // singletons
    // cfg also carries the optional-putaway switch, which defaults to off
    expect(s.cfg).toMatchObject(sampleState.cfg);
    expect(s.cfg.putawayEnabled).toBe(false);
    expect(s.seq).toEqual(sampleState.seq);

    // Per-account UI prefs no longer ride along in /api/state: stateSchema
    // never declared them, so they were silently dropped on every save. They
    // live in their own tables behind /api/ui-prefs and /api/gate-prefs (see
    // the test below), and must not reappear in the shared snapshot.
    expect(s.dfPrefs).toBeUndefined();
    expect(s.uiPrefs).toBeUndefined();
  });

  it('per-account UI prefs survive a full-state save and merge per key', async () => {
    const prefs = { demo: { ovMove: { mode: 'day', day: 7, month: 1, year: 1, from: '', to: '' } } };
    const put1 = await request(ctx.app).put('/api/ui-prefs').set(auth(ctx.token)).send(prefs);
    expect(put1.status).toBe(200);

    // Simulate what save()/renderAll() does constantly: PUT the whole S again
    // with unrelated fields touched.
    await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(sampleState);
    await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({ ...sampleState, boxes: {} });

    // A second tab saving a different key must not erase the first one.
    await request(ctx.app).put('/api/ui-prefs').set(auth(ctx.token)).send({ theme: 'dark' });

    const get = await request(ctx.app).get('/api/ui-prefs').set(auth(ctx.token));
    expect(get.status).toBe(200);
    expect(get.body.demo).toEqual(prefs.demo);
    expect(get.body.theme).toBe('dark');
  });

  it('serves the PDA a bounded snapshot: recent movements only, no web-only data', async () => {
    const recent = { ts: new Date().toISOString(), dir: 'in', tag: 'BTX-2601-ABCDE' };
    const box = sampleState.boxes['BTX-2601-ABCDE'];
    const history = Array.from({ length: 8 }, (_, i) => ({ dir: 'relocate', ts: `2026-07-2${i}T00:00:00.000Z` }));
    await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({
      ...sampleState,
      restore: true,
      boxes: { 'BTX-2601-ABCDE': { ...box, history } },
      events: [...sampleState.events, recent],
    });
    const full = (await request(ctx.app).get('/api/state').set(auth(ctx.token))).body;
    const res = await request(ctx.app).get('/api/state/pda').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.boxes['BTX-2601-ABCDE'].history).toEqual(history.slice(-6));
    expect(res.body.events).toEqual([recent]);
    expect(res.body.employees).toEqual(full.employees);
    expect(Object.keys(res.body).sort()).toEqual(
      ['boxes', 'boxtypes', 'cfg', 'customers', 'employees', 'events', 'gates', 'locations', 'warehouses'],
    );
    expect((await request(ctx.app).get('/api/state/pda')).status).toBe(401);
  });

  it('keeps a due date the web moved on a box that is still out', async () => {
    const state = (await request(ctx.app).get('/api/state').set(auth(ctx.token))).body;
    const box = state.boxes['BTX-2601-ABCDE'];
    box.status = 'out';
    box.dueAt = '2027-01-15T16:59:59.999Z';
    box.dueDate = '15/01/2027';
    box.history = [...box.history, { dir: 'due', ts: new Date().toISOString(), dueAt: box.dueAt }];
    const res = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({ ...state, restore: false });
    expect(res.body.rejected).toEqual([]);
    const after = (await request(ctx.app).get('/api/state').set(auth(ctx.token))).body.boxes['BTX-2601-ABCDE'];
    expect([after.dueAt, after.dueDate, after.history.at(-1).dir]).toEqual([box.dueAt, box.dueDate, 'due']);
  });

  it('replaces (not merges) on subsequent PUT', async () => {
    await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({ boxes: {}, customers: {} });
    const get = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(Object.keys(get.body.boxes)).toHaveLength(0);
    expect(Object.keys(get.body.customers)).toHaveLength(0);
  });
});
