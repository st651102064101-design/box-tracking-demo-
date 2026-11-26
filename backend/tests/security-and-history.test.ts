import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { boxes, boxTypes, customers, employees, events, gates, users, warehouses } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { recordRfidObservation } from '../src/routes/lpr.js';
import { env } from '../src/env.js';

let ctx: TestCtx;
let staff: string;
let viewer: string;

async function loginAs(username: string, role: 'staff' | 'viewer') {
  await getDb().insert(users).values({ username, passwordHash: await hashPassword('pass-123456'), name: username, role });
  const res = await request(ctx.app).post('/api/auth/login').send({ username, password: 'pass-123456' });
  return res.body.token as string;
}

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  staff = await loginAs('s.staff', 'staff');
  viewer = await loginAs('v.viewer', 'viewer');
  await db.insert(employees).values([1, 2, 3].map((n) => ({ id: `E-${n}`, name: `emp ${n}`, data: {} })));
  await db.insert(warehouses).values([{ id: 'WH-A', name: 'A', data: {} }, { id: 'WH-B', name: 'B', data: {} }]);
  await db.insert(gates).values([{ gateNo: 1, warehouseId: 'WH-A' }, { gateNo: 2, warehouseId: 'WH-B' }]);
  await db.insert(boxTypes).values({ id: 'BT', name: 'bt' });
  await db.insert(customers).values({ id: 'C-1', name: 'cust', data: {} });
  await db.insert(boxes).values({ tag: 'H-1', type: 'BT', status: 'warehouse', history: [{ dir: 'in', wh: 'WH-A' }], data: { tag: 'H-1', status: 'warehouse', history: [{ dir: 'in', wh: 'WH-A' }] } });
});

const creds = (token: string, id: string, username: string) =>
  request(ctx.app).put(`/api/employees/${id}/credentials`).set(auth(token)).send({ username, password: 'Strong#Pass12' });
const setPin = (token: string, id: string, body: object) =>
  request(ctx.app).put(`/api/employees/${id}/pin`).set(auth(token)).send(body);
const verify = (id: string, pin: string) =>
  request(ctx.app).post(`/api/employees/${id}/pin/verify`).set(auth(staff)).send({ pin });

describe('employee credentials', () => {
  it('cannot be set by staff or a viewer', async () => {
    expect((await creds(staff, 'E-1', 'takeover')).status).toBe(403);
    expect((await creds(viewer, 'E-1', 'takeover')).status).toBe(403);
  });
  it('can be set by an admin, and edited later without retyping the password', async () => {
    expect((await creds(ctx.token, 'E-1', 'emp.one')).status).toBe(200);
    const again = await request(ctx.app).put('/api/employees/E-1/credentials').set(auth(ctx.token)).send({ username: 'emp.uno', email: 'one@example.com' });
    expect(again.status).toBe(200);
    expect(again.body.account).toMatchObject({ username: 'emp.uno', email: 'one@example.com' });
  });
  it('cannot reuse a system account name', async () => {
    expect((await creds(ctx.token, 'E-2', 'admin')).status).toBe(409);
  });
});

describe('PDA PIN', () => {
  it('lets a gate account set a first PIN but not replace one without the old PIN', async () => {
    expect((await setPin(staff, 'E-2', { pin: '1234' })).status).toBe(200);
    expect((await setPin(staff, 'E-2', { pin: '9999' })).status).toBe(403);
    expect((await setPin(staff, 'E-2', { pin: '9999', currentPin: '0000' })).status).toBe(403);
    expect((await setPin(staff, 'E-2', { pin: '9999', currentPin: '1234' })).status).toBe(200);
  });
  it('refuses a viewer', async () => {
    expect((await setPin(viewer, 'E-3', { pin: '1234' })).status).toBe(403);
  });
  it('locks after five wrong tries, even for the right PIN', async () => {
    await setPin(ctx.token, 'E-3', { pin: '4321' });
    for (let i = 0; i < 5; i++) expect((await verify('E-3', '0000')).body.ok).toBe(false);
    expect((await verify('E-3', '4321')).status).toBe(429);
  });
});

describe('gate scans keep box history', () => {
  const gate = (dir: 'in' | 'out', n: number) =>
    request(ctx.app).post(`/api/gate/${dir}`).set(auth(ctx.token)).send({ tags: ['H-1'], gate: n, ...(dir === 'out' ? { customer: 'C-1' } : {}) });
  const row = async () => (await getDb().select().from(boxes).where(eq(boxes.tag, 'H-1')))[0];

  it('ships from the warehouse that just received the box', async () => {
    expect((await gate('out', 1)).status).toBe(200);
    expect((await gate('in', 2)).status).toBe(200);
    expect((await gate('out', 2)).status).toBe(200);
    const r = await row();
    expect(r.history).toEqual((r.data as { history: unknown[] }).history);
  });

  it('keeps who returned the box on the return event and history', async () => {
    const doNo = (await row()).doNo;
    await gate('in', 2);
    const ev = (await getDb().select().from(events)).map((e) => e.data as Record<string, unknown>).filter((d) => d.dir === 'in').pop();
    expect(ev).toMatchObject({ customer: 'C-1', do: doNo });
    expect((await row()).history).toContainEqual(expect.objectContaining({ dir: 'in', customer: 'C-1', do: doNo }));
  });

  it('is not erased by an LPR detection, and the barrier opens for boxes RFID already shipped', async () => {
    await request(ctx.app).put('/api/rfid/gates/2/auto-session').set(auth(ctx.token)).send({ direction: 'out', customer: 'C-1', plate: 'AB-1' });
    await getDb().update(warehouses).set({ gateType: 'out' }).where(eq(warehouses.id, 'WH-B'));
    expect((await gate('out', 2)).status).toBe(200);
    const before = ((await row()).history as unknown[]).length;
    recordRfidObservation('GATE-2', ['H-1']);
    const res = await request(ctx.app).post('/api/gate/lpr').set('X-LPR-Webhook-Secret', env.lprWebhookSecret).send({
      eventId: 'h-1', cameraId: 'c', plateNumber: 'AB-1', confidence: 0.99, gateId: 2, timestamp: new Date().toISOString(), vehicleColor: 'w',
    });
    expect(res.body.action).toBe('open_gate');
    const history = (await row()).history as Array<{ dir: string }>;
    expect(history).toHaveLength(before + 1);
    expect(history.slice(-2).map((h) => h.dir)).toEqual(['out', 'lpr']);
  });
});

describe('small API guards', () => {
  it('refuses an auto session for a gate that does not exist', async () => {
    const res = await request(ctx.app).put('/api/rfid/gates/999/auto-session').set(auth(ctx.token)).send({ direction: 'in' });
    expect(res.status).toBe(404);
  });
});
