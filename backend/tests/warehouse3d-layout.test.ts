import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { events } from '../src/db/schema.js';
import { deriveWarehouseGeometry } from '../src/services/warehouseGeometry.js';

/** Rack code → one rack with `slots` bays on one shelf. */
const locations = (counts: Record<string, number>) => Object.fromEntries(
  Object.entries(counts).flatMap(([rack, n]) => Array.from({ length: n }, (_, i) => {
    const code = `${rack}-${i}`;
    return [code, { code, wh: 'WH', zone: 'A', rack, shelf: '1', slot: String(i + 1) }] as const;
  })),
);
const overlaps = (racks: { positionXCm: number; positionZCm: number; widthCm: number }[]) => racks.some((a, i) =>
  racks.slice(i + 1).some((b) => a.positionZCm === b.positionZCm
    && Math.abs(a.positionXCm - b.positionXCm) < (a.widthCm + b.widthCm) / 2));

describe('automatic rack layout', () => {
  const map = locations({ R1: 5, R2: 4, R3: 4, R4: 4, R5: 2 });

  it('never places wide racks on top of each other', () => {
    const { rackRows } = deriveWarehouseGeometry(map, {}, {});
    expect(rackRows).toHaveLength(5);
    expect(overlaps(rackRows)).toBe(false);
  });

  it('re-lays racks left on the old fixed grid, and keeps hand-placed ones', () => {
    const fresh = deriveWarehouseGeometry(map, {}, {}).rackRows;
    const stored = fresh.map((r, i) => ({ ...r, positionXCm: (i % 4) * 1000, positionZCm: Math.floor(i / 4) * 600 }));
    stored[2] = { ...stored[2], positionXCm: 9000 };
    const next = deriveWarehouseGeometry(map, {}, {}, stored as never).rackRows;
    expect(next[2].positionXCm).toBe(9000);
    expect(overlaps(next)).toBe(false);
    expect(deriveWarehouseGeometry(map, {}, {}, next as never).rackRows.map((r) => r.positionXCm))
      .toEqual(next.map((r) => r.positionXCm)); // stable on the next save
  });
});

describe('3D doors follow gate activity', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await bootstrap(); });

  it('reports how long ago something passed each gate', async () => {
    await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({
      warehouses: { WH: { id: 'WH', name: 'w', gates: [1, 2, 3] } },
      gates: { 1: 'WH', 2: 'WH', 3: 'WH' },
    });
    await getDb().insert(events).values([
      { ts: new Date(Date.now() - 5_000), data: { dir: 'in', gate: 1 } },
      { ts: new Date(Date.now() - 3_600_000), data: { dir: 'in', gate: 2 } },
    ]);
    const res = await request(ctx.app).get('/api/warehouse-3d?warehouseId=WH').set(auth(ctx.token));
    const age = Object.fromEntries(res.body.doors.map((d: { gateNo: number; activityAgeMs: number | null }) => [d.gateNo, d.activityAgeMs]));
    expect(age[1]).toBeGreaterThanOrEqual(5_000);
    expect(age[1]).toBeLessThan(15_000);
    expect([age[2], age[3]]).toEqual([null, null]);
  });
});
