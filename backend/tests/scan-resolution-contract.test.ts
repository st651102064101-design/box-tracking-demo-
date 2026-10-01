import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { auth, bootstrap, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { resolveBoxesByCodes } from '../src/services/rfid.js';

let ctx: TestCtx;
const state = {
  boxes: {
    'OTHER': { tag: 'OTHER', status: 'warehouse', rfid: 'COLLISION', history: [], location: { wh: 'WH-1' } },
    'COLLISION': { tag: 'COLLISION', status: 'warehouse', history: [], location: { wh: 'WH-1' } },
    'BOX-A': { tag: 'BOX-A', status: 'warehouse', rfid: 'E200ABCD', history: [], location: { wh: 'WH-1' } },
    'BOX-B': { tag: 'BOX-B', status: 'warehouse', rfidEpc: 'E2001122', rfidTid: 'E2801122', history: [], location: { wh: 'WH-1' } },
  },
  customers: { C: { id: 'C', name: 'Customer', returnDays: 10 } },
  warehouses: { 'WH-1': { id: 'WH-1', name: 'Warehouse', gates: [1], gateTypes: { '1': 'both' } } },
  gates: { '1': 'WH-1' },
};
beforeAll(async () => { ctx = await bootstrap(); });
beforeEach(async () => {
  const result = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(state);
  expect(result.status).toBe(200);
});
describe('scan identity contract across API and state', () => {
  it('barcode takes precedence over another box RFID identifier', async () => {
    const result = await resolveBoxesByCodes(getDb(), ['COLLISION']);
    expect(result.resolved.get('COLLISION')?.tag).toBe('COLLISION');
  });
  it('batch resolves current RFID and legacy EPC/TID, deduplicating exact inputs', async () => {
    const result = await resolveBoxesByCodes(getDb(), ['BOX-A', 'E200ABCD', 'E2001122', 'E2801122', 'E200ABCD', 'MISSING']);
    expect([...result.resolved.values()].map(b => b.tag)).toEqual(['BOX-A', 'BOX-A', 'BOX-B', 'BOX-B']);
    expect(result.missing).toEqual(['MISSING']);
    expect((await resolveBoxesByCodes(getDb(), [])).resolved.size).toBe(0);
  });
  it('documents exact-case API resolution; client-side normalization is separate', async () => {
    const result = await resolveBoxesByCodes(getDb(), ['e200abcd', ' E200ABCD ', 'box-a']);
    expect(result.missing).toEqual(['e200abcd', ' E200ABCD ', 'box-a']);
  });
  it('replayed gate callback and mixed aliases do not create duplicate history', async () => {
    const sendOut = () => request(ctx.app).post('/api/gate/out').set(auth(ctx.token))
      .send({ tags: ['BOX-A', 'E200ABCD', 'BOX-A'], customer: 'C', gate: 1 });
    const first = await sendOut();
    expect(first.status).toBe(200);
    expect(first.body.shipped).toEqual(['BOX-A']);
    expect((await sendOut()).status).toBe(409);
    const inbound = { tags: ['BOX-A', 'E200ABCD', 'E200ABCD'], gate: 1 };
    expect((await request(ctx.app).post('/api/gate/in').set(auth(ctx.token)).send(inbound)).body.received).toEqual(['BOX-A']);
    await request(ctx.app).post('/api/gate/in').set(auth(ctx.token)).send(inbound);
    const box = await request(ctx.app).get('/api/boxes/BOX-A').set(auth(ctx.token));
    expect(box.body.history.filter((h: { dir: string }) => h.dir === 'out')).toHaveLength(1);
    expect(box.body.history.filter((h: { dir: string }) => h.dir === 'in')).toHaveLength(1);
  });
  it('replace cannot steal a legacy TID; failed binding leaves state untouched', async () => {
    const result = await request(ctx.app).post('/api/boxes/BOX-A/rfid').set(auth(ctx.token))
      .send({ rfid: 'E2801122', replace: true });
    expect(result.status).toBe(409);
    expect((await request(ctx.app).get('/api/boxes/BOX-A').set(auth(ctx.token))).body.rfid).toBe('E200ABCD');
  });
});
