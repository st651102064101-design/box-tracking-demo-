import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { boxes, racks, slots, warehouses } from '../src/db/schema.js';
import { auth, bootstrap, type TestCtx } from './helpers.js';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  await db.insert(warehouses).values({ id: 'WH-3D', name: 'Inventory 3D' });
  await db.insert(racks).values({ id: 'RACK-3D-A', warehouseId: 'WH-3D', zone: 'A', code: 'R-01' });
  await db.insert(slots).values([
    { id: 'SLOT-01', rackId: 'RACK-3D-A', shelfCode: '01', slotCode: '01', data: { barcode: 'SLOT-01' } },
    { id: 'SLOT-02', rackId: 'RACK-3D-A', shelfCode: '01', slotCode: '02', data: { barcode: 'SLOT-02' } },
    {
      id: 'SLOT-BLOCKED',
      rackId: 'RACK-3D-A',
      shelfCode: '01',
      slotCode: '03',
      data: { barcode: 'SLOT-BLOCKED', reportedFullAt: new Date().toISOString() },
    },
  ]);
  await db.insert(boxes).values([
    {
      tag: 'PUT-01', status: 'pending', labeled: true,
      location: { wh: 'WH-3D', staging: true }, data: { tag: 'PUT-01', status: 'pending', labeled: true },
    },
    {
      tag: 'PUT-02', status: 'pending', labeled: true,
      location: { wh: 'WH-3D', staging: true }, data: { tag: 'PUT-02', status: 'pending', labeled: true },
    },
    {
      tag: 'PUT-03', status: 'pending', labeled: true,
      location: { wh: 'WH-3D', staging: true }, data: { tag: 'PUT-03', status: 'pending', labeled: true },
    },
    {
      tag: 'HOLD-01', status: 'hold', labeled: true,
      location: { wh: 'WH-3D', zone: 'A', rack: 'R-01', shelf: '01', slot: '02' },
      data: { tag: 'HOLD-01', status: 'hold', labeled: true },
    },
    {
      tag: 'RETURN-01', status: 'warehouse', labeled: true, slotId: 'SLOT-BLOCKED',
      location: { wh: 'WH-3D', zone: 'A', rack: 'R-01', shelf: '01', slot: '03' },
      data: { tag: 'RETURN-01', status: 'warehouse', labeled: true },
    },
  ]);
});

const place = (tag: string, slot: string, side?: 'left' | 'right') => request(ctx.app)
  .post(`/api/boxes/${tag}/putaway`)
  .set(auth(ctx.token))
  .send({ wh: 'WH-3D', zone: 'A', rack: 'R-01', shelf: '01', slot, ...(side ? { side } : {}) });

describe('inventory-only 3D putaway consistency', () => {
  it('resolves the exact DB slot and fills its two pallet positions', async () => {
    const first = await place('PUT-01', '01');
    const second = await place('PUT-02', '01');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'warehouse', slotId: 'SLOT-01' });
    expect(second.body).toMatchObject({ status: 'warehouse', slotId: 'SLOT-01' });
    expect(first.body.history.at(-1).dir).toBe('putaway');

    const db = getDb();
    const [slot] = await db.select().from(slots).where(eq(slots.id, 'SLOT-01'));
    expect(slot.status).toBe('full');
  });

  it('rejects a third pallet without moving it out of staging', async () => {
    const response = await place('PUT-03', '01');
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('slot_full');

    const [box] = await getDb().select().from(boxes).where(eq(boxes.tag, 'PUT-03'));
    expect(box).toMatchObject({ status: 'pending', slotId: null });
    expect(box.location).toMatchObject({ wh: 'WH-3D', staging: true });
  });

  it('rejects unknown and manually reported-full destinations', async () => {
    const missing = await place('PUT-03', '99');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('slot_not_found');

    const blocked = await place('PUT-03', '03');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('slot_full');
  });

  it('allows a lifted box to return to its own manually-full source slot', async () => {
    const response = await place('RETURN-01', '03', 'right');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'warehouse', slotId: 'SLOT-BLOCKED', slotSide: 'right' });
    expect(response.body.history.at(-1).dir).toBe('relocate');

    const view = await request(ctx.app)
      .get('/api/warehouse-3d?warehouseId=WH-3D')
      .set(auth(ctx.token));
    expect(view.body.boxes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'RETURN-01', slotId: 'SLOT-BLOCKED', slotSide: 'right' }),
    ]));
  });

  it('relocates a warehouse box, frees source capacity, and logs relocate', async () => {
    const response = await place('PUT-01', '02');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'warehouse', slotId: 'SLOT-02' });
    expect(response.body.history.at(-1).dir).toBe('relocate');

    const db = getDb();
    const [source] = await db.select().from(slots).where(eq(slots.id, 'SLOT-01'));
    const [destination] = await db.select().from(slots).where(eq(slots.id, 'SLOT-02'));
    expect(source.status).toBe('empty');
    expect(destination.status).toBe('full');
  });

  it('keeps held/damaged inventory visible but refuses forklift relocation', async () => {
    const response = await place('HOLD-01', '01');
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('box_not_putaway_eligible');

    const view = await request(ctx.app)
      .get('/api/warehouse-3d?warehouseId=WH-3D')
      .set(auth(ctx.token));
    expect(view.status).toBe(200);
    expect(view.body.boxes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'HOLD-01', status: 'hold', slotId: 'SLOT-02' }),
    ]));
  });
});
