import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { rfidAntennaGateMappings, rfidGateAutoSessions, rfidReaders, fx9600Readers } from '../src/db/schema.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

const get = async () => (await request(ctx.app).get('/api/state').set(auth(ctx.token))).body;
const put = (state: unknown) => request(ctx.app).put('/api/state').set(auth(ctx.token)).send(state as object);
const box = (tag: string, wh: string) => ({
  tag, type: 'BT', status: 'warehouse', location: { wh }, history: [{ dir: 'in', wh }],
});
/** What the web app does on Gate Out: flip the box and log an event, then upload everything. */
function ship(state: any, tag: string, gate: number, wh: string) {
  const b = state.boxes[tag];
  Object.assign(b, { status: 'out', customer: 'C-1', do: 'DO-1', outGate: gate, outWh: wh, outAt: '2026-11-26T01:00:00.000Z' });
  b.history = [...b.history, { dir: 'out', gate, wh, ts: '2026-11-26T01:00:00.000Z' }];
  state.events = [...(state.events ?? []), { dir: 'out', tag, gate, wh, ts: '2026-11-26T01:00:00.000Z' }];
}

describe('web gate out (whole-state save)', () => {
  beforeAll(async () => {
    const res = await put({
      warehouses: { 'WH-1': { id: 'WH-1', name: 'a', gates: [1] }, 'WH-2': { id: 'WH-2', name: 'b', gates: [2] } },
      gates: { 1: 'WH-1', 2: 'WH-2' },
      boxtypes: { BT: { id: 'BT', name: 'bt' } },
      customers: { 'C-1': { id: 'C-1', name: 'c' } },
      boxes: { A: box('A', 'WH-1'), B: box('B', 'WH-2') },
    });
    expect(res.status).toBe(200);
  });

  it('refuses to ship a box from another warehouse, keeping the rest of the save', async () => {
    const state = await get();
    ship(state, 'A', 2, 'WH-2'); // wrong warehouse
    ship(state, 'B', 2, 'WH-2'); // right one
    const res = await put(state);
    expect(res.status).toBe(200);
    expect(res.body.rejected.map((r: { key: string }) => r.key)).toEqual(['gateOwnership']);
    expect(res.body.rejected[0].message).toContain('A');
    const after = await get();
    expect(after.boxes.A.status).toBe('warehouse');
    expect(after.boxes.B.status).toBe('out');
    expect(after.events.filter((e: { dir: string }) => e.dir === 'out').map((e: { tag: string }) => e.tag)).toEqual(['B']);
  });

  it('allows a box received at the other warehouse in the same save', async () => {
    const state = await get();
    state.boxes.A.location = { wh: 'WH-2' };
    ship(state, 'A', 2, 'WH-2');
    const res = await put(state);
    expect(res.body.rejected).toEqual([]);
    expect((await get()).boxes.A.status).toBe('out');
  });
});

describe('system wipe', () => {
  it('also removes reader bindings and staged gate sessions', async () => {
    const db = getDb();
    await db.insert(rfidReaders).values({ id: 'r1', name: 'r', host: 'h', gateNo: 1, webhookUrl: 'http://x', transmitPower: '1.00', antennaCount: 1 });
    await db.insert(rfidAntennaGateMappings).values({ readerId: 'r1', antennaPort: 1, gateNo: 1, antennaRole: 'direct' });
    await db.insert(rfidGateAutoSessions).values({ gateNo: 1, direction: 'in', expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(fx9600Readers).values({ id: 'f1', gateNo: 1 });
    expect((await request(ctx.app).post('/api/system/wipe').set(auth(ctx.token))).status).toBe(200);
    for (const table of [rfidReaders, rfidAntennaGateMappings, rfidGateAutoSessions, fx9600Readers]) {
      expect(await db.select().from(table)).toEqual([]);
    }
  });
});
