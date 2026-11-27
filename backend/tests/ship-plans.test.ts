/** See docs/superpowers/specs/2026-11-26-gate-systems-design.md */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { GATE, makeWorld, type World } from './workflows/world.js';

let w: World;
let clock = Date.now();
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  w = await makeWorld();
});
/* Each case is a new truck: let earlier plates and tags fall out of the window. */
beforeEach(async () => {
  clock += 120_000;
  vi.setSystemTime(clock);
  for (const p of await plans()) if (p.status === 'waiting') await w.api().delete(`/api/ship-plans/${p.id}`).set(w.as);
  await w.api().delete(`/api/rfid/gates/${GATE.out}/auto-session`).set(w.as);
});
afterAll(() => { vi.useRealTimers(); });

const add = (rows: object[]) => w.api().post('/api/ship-plans').set(w.as).send({ rows });
const plans = async (): Promise<{ id: number; plate: string; status: string; shippedTags: string[] }[]> =>
  (await w.api().get('/api/ship-plans').set(w.as)).body.plans;
const planOf = async (plate: string) => (await plans()).filter((p) => p.plate === plate);
const customerOf = async (tag: string) => {
  const row = await w.row(tag);
  return [row.status, row.customer];
};

describe('importing the shipping list', () => {
  it('keeps good rows and says which ones it could not use', async () => {
    const res = await add([
      { plate: '70 1001', customer: 'two', doNo: 'DO-A' },
      { plate: '', customer: 'C1' },
      { plate: '70-1002', customer: 'nobody' },
      { plate: '70-1003', customer: 'C1', date: '31/02/2026' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4]);
    expect(await planOf('701001')).toMatchObject([{ status: 'waiting', customer: 'C2', doNo: 'DO-A' }]);
  });

  it('requires the right to ship', async () => {
    expect((await w.api().post('/api/ship-plans').send({ rows: [] })).status).toBe(401);
  });
});

describe('who an unattended gate ships to', () => {
  it('uses the plan for the plate, whether the camera comes after the tags', async () => {
    await w.stocked('P-1'); await w.stocked('P-2');
    await add([{ plate: '71-1111', customer: 'C2', doNo: 'DO-P1' }]);
    await w.session(GATE.out, { customer: 'C1' });
    await w.read(GATE.out, ['P-1', 'P-2']);
    expect(await customerOf('P-1')).toEqual(['warehouse', null]); // waits for the plate
    await w.camera(GATE.out, '71-1111');
    expect(await customerOf('P-1')).toEqual(['out', 'C2']);
    expect(await customerOf('P-2')).toEqual(['out', 'C2']);
    expect(await planOf('71-1111')).toMatchObject([{ status: 'shipped', shippedTags: ['P-1', 'P-2'] }]);
  });

  it('or before them, covering every box of that truck', async () => {
    await w.stocked('Q-1'); await w.stocked('Q-2');
    await add([{ plate: '72-2222', customer: 'C2' }]);
    await w.camera(GATE.out, '72-2222');
    await w.read(GATE.out, ['Q-1']);
    await w.read(GATE.out, ['Q-2']);
    expect(await customerOf('Q-1')).toEqual(['out', 'C2']);
    expect(await customerOf('Q-2')).toEqual(['out', 'C2']);
    expect((await planOf('72-2222'))[0].shippedTags).toEqual(['Q-1', 'Q-2']);
  });

  it('uses a plan once: the truck coming back needs a new one', async () => {
    await w.stocked('R-1'); await w.stocked('R-2');
    await add([{ plate: '73-3333', customer: 'C2' }]);
    await w.camera(GATE.out, '73-3333');
    await w.read(GATE.out, ['R-1']);
    clock += 120_000; vi.setSystemTime(clock);
    await w.camera(GATE.out, '73-3333');
    await w.read(GATE.out, ['R-2']);
    expect(await customerOf('R-2')).toEqual(['warehouse', null]);
  });

  it('falls back to the customer set at the gate for a truck not on the list', async () => {
    await w.stocked('S-1');
    await add([{ plate: '74-4444', customer: 'C2' }]);
    await w.session(GATE.out, { customer: 'C1' });
    await w.camera(GATE.out, '99-0000');
    await w.read(GATE.out, ['S-1']);
    await w.camera(GATE.out, '99-0000');
    expect(await customerOf('S-1')).toEqual(['out', 'C1']);
    expect((await planOf('74-4444'))[0].status).toBe('waiting');
  });

  it('holds the box for review when plans wait and no plate is read', async () => {
    await w.stocked('T-1');
    await add([{ plate: '75-5555', customer: 'C2' }]);
    await w.session(GATE.out, { customer: 'C1' });
    await w.read(GATE.out, ['T-1']);
    expect(await customerOf('T-1')).toEqual(['warehouse', null]);
    expect(await w.pending(GATE.out)).toContain('T-1');
  });

  it('does not trust a doubtful plate', async () => {
    await w.stocked('U-1');
    await add([{ plate: '76-6666', customer: 'C2' }]);
    await w.read(GATE.out, ['U-1']);
    await w.camera(GATE.out, '76-6666', { confidence: 0.4 });
    expect(await customerOf('U-1')).toEqual(['warehouse', null]);
    expect((await planOf('76-6666'))[0].status).toBe('waiting');
  });

  it('ignores a plan dated another day', async () => {
    await w.stocked('V-1');
    await add([{ plate: '77-7777', customer: 'C2', date: '2030-01-01' }]);
    await w.read(GATE.out, ['V-1']);
    await w.camera(GATE.out, '77-7777');
    expect(await customerOf('V-1')).toEqual(['warehouse', null]);
  });
});

describe('the customer set at a gate', () => {
  it('can be read back until it is cleared', async () => {
    const read = async () => (await w.api().get(`/api/rfid/gates/${GATE.out}/auto-session`).set(w.as)).body.session;
    expect(await read()).toBeNull();
    await w.session(GATE.out, { customer: 'C2' });
    expect(await read()).toMatchObject({ direction: 'out', customer: 'C2' });
    await w.api().delete(`/api/rfid/gates/${GATE.out}/auto-session`).set(w.as);
    expect(await read()).toBeNull();
  });
});

describe('a customer set at the gate stays usable', () => {
  const put = (body: object) => w.api().put(`/api/rfid/gates/${GATE.out}/auto-session`).set(w.as).send({ direction: 'out', ...body });
  const read = async () => (await w.api().get(`/api/rfid/gates/${GATE.out}/auto-session`).set(w.as)).body;
  const clear = (query = '') => w.api().delete(`/api/rfid/gates/${GATE.out}/auto-session${query}`).set(w.as);
  beforeEach(async () => { await clear('?preset=1'); });

  it('serves the next truck too, whatever its plate', async () => {
    await w.stocked('K-1'); await w.stocked('K-2');
    await put({ customer: 'C1', preset: true, ttlSeconds: 7200 });
    await w.camera(GATE.out, '81-0001');
    await w.read(GATE.out, ['K-1']);
    await w.camera(GATE.out, '81-0001');
    clock += 120_000; vi.setSystemTime(clock);
    await w.read(GATE.out, ['K-2']);
    const res = await w.camera(GATE.out, '82-0002');
    expect(res.body.action).toBe('open_gate');
    expect(await customerOf('K-1')).toEqual(['out', 'C1']);
    expect(await customerOf('K-2')).toEqual(['out', 'C1']);
  });

  it('reports when it started and how long it lasts', async () => {
    await put({ customer: 'C1', preset: true, ttlSeconds: 7200 });
    const body = await read();
    expect(body.session).toMatchObject({ customer: 'C1', permanent: false, ttlSeconds: 7200 });
    expect(Date.parse(body.session.expiresAt) - Date.parse(body.session.startedAt)).toBe(7_200_000);
    expect(Date.parse(body.now)).toBe(clock);
  });

  it('remembers the last one after it runs out', async () => {
    await put({ customer: 'C2', preset: true, ttlSeconds: 60 });
    clock += 120_000; vi.setSystemTime(clock);
    const body = await read();
    expect(body.session).toBeNull();
    expect(body.expired).toMatchObject({ customer: 'C2', ttlSeconds: 60 });
  });

  it('can be permanent', async () => {
    await put({ customer: 'C1', preset: true, permanent: true });
    const { session } = await read();
    expect(session).toMatchObject({ customer: 'C1', permanent: true, ttlSeconds: null });
    expect(new Date(session.expiresAt).getUTCFullYear()).toBe(9999);
  });

  it('lists the live ones of every gate in one call', async () => {
    const list = async () => (await w.api().get('/api/rfid/gate-sessions').set(w.as)).body.sessions;
    expect(await list()).toEqual([]);
    await put({ customer: 'C1', preset: true, permanent: true });
    expect(await list()).toMatchObject([{ gateNo: GATE.out, direction: 'out', customer: 'C1', permanent: true }]);
  });

  it('is not overwritten or cleared by a screen that syncs on its own', async () => {
    await put({ customer: 'C1', preset: true, permanent: true });
    expect((await put({ customer: 'C2' })).status).toBe(200);
    await clear();
    expect((await read()).session).toMatchObject({ customer: 'C1', permanent: true });
    await clear('?preset=1');
    expect((await read()).session).toBeNull();
  });
});
