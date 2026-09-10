import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { getDb } from '../src/db/client.js';
import { boxes, locations, racks, slots, warehouses } from '../src/db/schema.js';
import { subscribe, subscribeForkliftState, type ForkliftStateEvent, type StateChangeEvent } from '../src/lib/bus.js';
import { synchronizeWarehouseGeometryFromLocationMaster } from '../src/services/state.js';
import { auth, bootstrap, type TestCtx } from './helpers.js';

let ctx: TestCtx;

const controllerHeaders = (clientId: string) => ({
  ...auth(ctx.token),
  'X-Client-Id': clientId,
});

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  await db.insert(warehouses).values([
    { id: 'WH-RT', name: 'Realtime warehouse' },
    { id: 'WH-STATUS', name: 'Status warehouse' },
  ]);
  await db.insert(racks).values({ id: 'RACK-STATUS', warehouseId: 'WH-STATUS', zone: 'A', code: 'R-01' });
  await db.insert(slots).values({ id: 'SLOT-STATUS', rackId: 'RACK-STATUS', shelfCode: '01', slotCode: '01' });
  const shelfLocation = { wh: 'WH-STATUS', zone: 'A', rack: 'R-01', shelf: '01', slot: '01' };
  await db.insert(boxes).values([
    { tag: 'BOX-HOLD', status: 'hold', slotId: 'SLOT-STATUS', location: shelfLocation },
    { tag: 'BOX-DAMAGE', status: 'damage', slotId: 'SLOT-STATUS', location: shelfLocation },
    { tag: 'BOX-OUT', status: 'out', slotId: 'SLOT-STATUS', location: shelfLocation },
  ]);
});

describe('warehouse 3D forklift controller lease', () => {
  it('requires a stable client id before a client can claim control', async () => {
    const response = await request(ctx.app)
      .post('/api/warehouse-3d/forklift/control/claim')
      .set(auth(ctx.token))
      .send({ warehouseId: 'WH-RT' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('client_id_required');
  });

  it('allows one controller, renews its lease, and rejects another client', async () => {
    const firstClaim = await request(ctx.app)
      .post('/api/warehouse-3d/forklift/control/claim')
      .set(controllerHeaders('client-a'))
      .send({ warehouseId: 'WH-RT' });
    expect(firstClaim.status).toBe(200);
    expect(firstClaim.body.forkliftController).toMatchObject({ active: true, isOwner: true, leaseMs: 10_000 });

    const firstExpiry = firstClaim.body.forkliftController.expiresAt as string;
    const renewal = await request(ctx.app)
      .post('/api/warehouse-3d/forklift/control/claim')
      .set(controllerHeaders('client-a'))
      .send({ warehouseId: 'WH-RT' });
    expect(renewal.status).toBe(200);
    expect(Date.parse(renewal.body.forkliftController.expiresAt)).toBeGreaterThanOrEqual(Date.parse(firstExpiry));

    const conflict = await request(ctx.app)
      .post('/api/warehouse-3d/forklift/control/claim')
      .set(controllerHeaders('client-b'))
      .send({ warehouseId: 'WH-RT' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: 'forklift_control_conflict',
      forkliftController: { active: true, isOwner: false },
    });

    const ownerView = await request(ctx.app)
      .get('/api/warehouse-3d?warehouseId=WH-RT')
      .set(controllerHeaders('client-a'));
    const spectatorView = await request(ctx.app)
      .get('/api/warehouse-3d?warehouseId=WH-RT')
      .set(controllerHeaders('client-b'));
    expect(ownerView.body.forkliftController).toMatchObject({ active: true, isOwner: true });
    expect(spectatorView.body.forkliftController).toMatchObject({ active: true, isOwner: false });
  });

  it('accepts owner motion, broadcasts a lightweight delta, and persists the last position', async () => {
    let received: ForkliftStateEvent | null = null;
    const unsubscribe = subscribeForkliftState((event) => { received = event; });
    const snapshot = {
      warehouseId: 'WH-RT',
      position: { x: 1.25, y: 0.02, z: -3.5 },
      rotationY: 1.2,
      target: { x: 4, y: 0.02, z: -2 },
      liftHeight: 0.8,
      cargoBoxId: 'BOX-ON-FORKS',
      moving: true,
      layoutRevision: 'WH-RT:1:test',
    };

    const movement = await request(ctx.app)
      .put('/api/warehouse-3d/forklift')
      .set(controllerHeaders('client-a'))
      .send(snapshot);
    unsubscribe();

    expect(movement.status).toBe(200);
    expect(movement.body.forkliftController).toMatchObject({ active: true, isOwner: true });
    expect(received).toMatchObject({ ...snapshot, origin: 'client-a' });
    expect((received as ForkliftStateEvent | null)?.updatedAt).toEqual(expect.any(String));

    const persisted = await request(ctx.app)
      .get('/api/warehouse-3d?warehouseId=WH-RT')
      .set(controllerHeaders('client-a'));
    expect(persisted.body.forkliftPosition).toMatchObject({
      position: snapshot.position,
      rotationY: snapshot.rotationY,
      target: snapshot.target,
      liftHeight: snapshot.liftHeight,
      cargoBoxId: snapshot.cargoBoxId,
      moving: true,
      layoutRevision: snapshot.layoutRevision,
    });
  });

  it('rejects conflicting motion, then transfers control after an owner release', async () => {
    const blocked = await request(ctx.app)
      .put('/api/warehouse-3d/forklift')
      .set(controllerHeaders('client-b'))
      .send({ warehouseId: 'WH-RT', position: { x: 99, y: 0, z: 99 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('forklift_control_conflict');

    const release = await request(ctx.app)
      .post('/api/warehouse-3d/forklift/control/release')
      .set(controllerHeaders('client-a'))
      .send({ warehouseId: 'WH-RT' });
    expect(release.status).toBe(200);
    expect(release.body).toMatchObject({
      ok: true,
      released: true,
      forkliftController: { active: false, isOwner: false },
    });

    const takeover = await request(ctx.app)
      .put('/api/warehouse-3d/forklift')
      .set(controllerHeaders('client-b'))
      .send({ warehouseId: 'WH-RT', position: { x: 2, y: 0, z: 2 }, moving: false });
    expect(takeover.status).toBe(200);
    expect(takeover.body.forkliftPosition.cargoBoxId).toBeNull();
    expect(takeover.body.forkliftController).toMatchObject({ active: true, isOwner: true });
  });
});

describe('warehouse 3D on-site exception inventory', () => {
  it('keeps held and damaged shelf boxes visible and counted, but omits outbound boxes', async () => {
    const response = await request(ctx.app)
      .get('/api/warehouse-3d?warehouseId=WH-STATUS')
      .set(auth(ctx.token));

    expect(response.status).toBe(200);
    expect(response.body.boxes.map((box: { id: string; status: string }) => [box.id, box.status])).toEqual([
      ['BOX-HOLD', 'hold'],
      ['BOX-DAMAGE', 'damage'],
    ]);
    expect(response.body.racks[0].slots[0]).toMatchObject({ boxCount: 2, capacity: 2, status: 'full' });
  });
});

describe('warehouse 3D change notifications', () => {
  it('marks physical-layout writes with the warehouse3d scope', async () => {
    let received: StateChangeEvent | null = null;
    const unsubscribe = subscribe((event) => { received = event; });
    const response = await request(ctx.app)
      .put('/api/warehouse-3d/racks/RACK-STATUS')
      .set(controllerHeaders('layout-editor'))
      .send({ positionCm: { x: 125 } });
    unsubscribe();

    expect(response.status).toBe(200);
    expect(received).toMatchObject({ scope: 'warehouse3d', origin: 'layout-editor' });
  });

  it('notifies other screens when a box-type master changes', async () => {
    let received: StateChangeEvent | null = null;
    const unsubscribe = subscribe((event) => { received = event; });
    const response = await request(ctx.app)
      .post('/api/masters/box-types')
      .set(controllerHeaders('master-editor'))
      .send({ id: 'BT-RT-LIVE', name: 'Realtime carton', dim: '50x40x30' });
    unsubscribe();

    expect(response.status).toBe(201);
    expect(received).toMatchObject({ scope: 'state', origin: 'master-editor' });
  });

  it('projects a Location Master row written directly to DB into the 3D model', async () => {
    const db = getDb();
    await db.insert(warehouses).values({ id: 'WH-LOCATION-LIVE', name: 'Location-driven warehouse' });
    await db.insert(locations).values({
      code: 'LOC-LIVE-A-01-01', wh: 'WH-LOCATION-LIVE', zone: 'A', rack: 'R-01', shelf: '01', slot: '01',
      data: { code: 'LOC-LIVE-A-01-01', wh: 'WH-LOCATION-LIVE', zone: 'A', rack: 'R-01', shelf: '01', slot: '01' },
    });

    await synchronizeWarehouseGeometryFromLocationMaster(db);
    const response = await request(ctx.app)
      .get('/api/warehouse-3d?warehouseId=WH-LOCATION-LIVE')
      .set(auth(ctx.token));

    expect(response.status).toBe(200);
    expect(response.body.racks).toHaveLength(1);
    expect(response.body.racks[0]).toMatchObject({ warehouseId: 'WH-LOCATION-LIVE', zone: 'A', code: 'R-01' });
    expect(response.body.racks[0].slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'LOC-LIVE-A-01-01', shelfCode: '01', slotCode: '01' }),
    ]));
  });
});
