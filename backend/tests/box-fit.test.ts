/** See docs/superpowers/specs/2026-11-26-box-slot-fit-design.md */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { boxes, boxTypes } from '../src/db/schema.js';

let ctx: TestCtx;
const api = () => request(ctx.app);
const get = async () => (await api().get('/api/state').set(auth(ctx.token))).body;
const save = (state: object) => api().put('/api/state').set(auth(ctx.token)).send(state);
const row = async (tag: string) => (await getDb().select().from(boxes).where(eq(boxes.tag, tag)))[0];
const keys = (res: { body: { rejected: { key: string }[] } }) => res.body.rejected.map((r) => r.key);
const addType = (id: string, dim: string) => api().post('/api/masters/box-types').set(auth(ctx.token)).send({ id, name: id, dim });
const editType = (id: string, dim: string) => api().put(`/api/masters/box-types/${id}`).set(auth(ctx.token)).send({ name: id, dim });
async function box(tag: string, type: string) {
  expect((await api().post('/api/boxes').set(auth(ctx.token)).send({ tag, type })).status).toBe(200);
  await api().post(`/api/boxes/${tag}/label`).set(auth(ctx.token)).send({});
}
const at = (slot: string) => ({ wh: 'WH', zone: 'A', rack: 'R1', shelf: '1', slot });
const putaway = (tag: string, slot: string) => api().post(`/api/boxes/${tag}/putaway`).set(auth(ctx.token)).send(at(slot));
/** Slot 01 is standard (max 135×110×125); slot 02 is small (max 40×50×45). */
const loc = (slot: string, size?: object) => ({ code: `L-${slot}`, ...at(slot), ...(size ? { slot3d: { dimensionsCm: size } } : {}) });

beforeAll(async () => {
  ctx = await bootstrap();
  const res = await save({
    warehouses: { WH: { id: 'WH', name: 'w', gates: [1] } },
    gates: { 1: 'WH' },
    locations: { 'L-01': loc('01'), 'L-02': loc('02', { width: 80, height: 60, depth: 50 }) },
  });
  expect(res.status).toBe(200);
  // already wrong before the rule existed
  const old = { id: 'OLD', name: 'old', dim: '600x400x320' };
  await getDb().insert(boxTypes).values({ ...old, data: old });
  await addType('SMALL', '40x40x30');
  await addType('BIG', '120x100x100');
});

describe('box type size', () => {
  it('accepts the largest size a standard slot takes, and nothing above it', async () => {
    expect((await addType('MAX', '135x110x125')).status).toBe(201);
    for (const [id, dim] of [['W', '136x100x100'], ['D', '100x111x100'], ['H', '100x100x126'], ['MM', '600x400x320']]) {
      const res = await addType(id, dim);
      expect([res.status, res.body.error]).toEqual([409, 'box_too_big']);
      expect(res.body.message).toContain('135 × 110 × 125');
    }
    expect((await editType('SMALL', '900x40x30')).status).toBe(409);
  });

  it('accepts a type with no usable size', async () => {
    expect((await addType('NOSIZE', '')).status).toBe(201);
    expect((await addType('TEXT', 'ใหญ่')).status).toBe(201);
  });

  it('refuses a new or resized oversize type on a web save, keeping the rest', async () => {
    const state = await get();
    state.boxtypes.NEWBIG = { id: 'NEWBIG', name: 'n', dim: '500x40x30' };
    state.boxtypes.SMALL.dim = '500x40x30';
    state.boxtypes.OK = { id: 'OK', name: 'ok', dim: '50x40x30' };
    const res = await save(state);
    expect(keys(res)).toEqual(['boxTypeSize']);
    const after = (await get()).boxtypes;
    expect(after.NEWBIG).toBeUndefined();
    expect(after.SMALL.dim).toBe('40x40x30');
    expect(after.OK.dim).toBe('50x40x30');
  });

  it('leaves unrelated saves alone while an old oversize type exists', async () => {
    const state = await get();
    state.boxtypes.OLD.name = 'renamed';
    expect(keys(await save(state))).toEqual([]);
    expect((await get()).boxtypes.OLD.name).toBe('renamed');
  });

  it('resizes the boxes of a corrected type (API and web save)', async () => {
    await box('O-1', 'OLD');
    expect((await row('O-1')).widthCm).toBe(600);
    await editType('OLD', '60x40x32');
    expect(await row('O-1')).toMatchObject({ widthCm: 60, depthCm: 40, heightCm: 32 });
    const state = await get();
    state.boxtypes.OLD.dim = '50x30x20';
    await save(state);
    expect(await row('O-1')).toMatchObject({ widthCm: 50, depthCm: 30, heightCm: 20 });
    await save(state); // the same page, still holding the old box size
    expect(await row('O-1')).toMatchObject({ widthCm: 50, depthCm: 30, heightCm: 20 });
  });

  it('tells the web the largest size that fits', async () => {
    const res = await api().get('/api/masters/box-types/size-limit').set(auth(ctx.token));
    expect(res.body).toMatchObject({ width: 135, depth: 110, height: 125 });
  });
});

describe('putting a box into a slot', () => {
  it('judges the target slot', async () => {
    await box('B-1', 'BIG');
    const refused = await putaway('B-1', '02');
    expect([refused.status, refused.body.error]).toEqual([409, 'box_too_big']);
    expect((await putaway('B-1', '01')).status).toBe(200);
    await box('S-1', 'SMALL');
    expect((await putaway('S-1', '02')).status).toBe(200);
  });

  it('applies to a web relocation', async () => {
    const state = await get();
    const moved = state.boxes['B-1'];
    moved.location = { ...at('02') };
    moved.slotId = 'L-02';
    moved.history = [...moved.history, { dir: 'relocate', ts: new Date().toISOString() }];
    expect(keys(await save(state))).toEqual(['boxTooBig']);
    expect((await row('B-1')).slotId).toBe('L-01');
  });

  it('applies to a gate receipt that names a shelf', async () => {
    await api().post('/api/gate/in').set(auth(ctx.token)).send({ tags: ['B-1'], gate: 1 });
    await box('B-2', 'BIG');
    const res = await api().post('/api/gate/in').set(auth(ctx.token)).send({ tags: ['B-2'], gate: 1, location: at('02') });
    expect([res.status, res.body.error]).toEqual([409, 'box_too_big']);
    expect((await row('B-2')).status).toBe('pending');
  });

  it('suggests only a slot the box fits', async () => {
    await box('B-3', 'BIG');
    const res = await api().get('/api/boxes/suggest-location?wh=WH&tag=B-3').set(auth(ctx.token));
    expect(res.body.suggestion?.slot).toBe('01');
  });
});

describe('resizing a slot', () => {
  const resize = (id: string, widthCm: number) =>
    api().put(`/api/warehouse-3d/slots/${id}`).set(auth(ctx.token)).send({ dimensionsCm: { width: widthCm } });

  it('cannot shrink below the boxes standing in it, but an empty one can', async () => {
    expect((await resize('L-02', 60)).status).toBe(409); // S-1 (40 wide) needs 80
    expect((await resize('L-01', 200)).status).toBe(409); // B-1 (120 wide) needs 240
    expect((await resize('L-01', 240)).status).toBe(200);
  });
});
