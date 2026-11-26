import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { boxes, boxTypes, customers, employees, gates, warehouses } from '../src/db/schema.js';
import { env } from '../src/env.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  await db.insert(employees).values({ id: 'A-1', name: 'a', data: {} });
  await db.insert(warehouses).values({ id: 'WH-R', name: 'r', gateType: 'out', data: {} });
  await db.insert(gates).values([{ gateNo: 41, warehouseId: 'WH-R' }, { gateNo: 42, warehouseId: 'WH-R' }]);
  await db.insert(boxTypes).values({ id: 'BT', name: 'bt' });
  await db.insert(customers).values({ id: 'C-1', name: 'c', data: {} });
  await db.insert(boxes).values(['R-1', 'R-2'].map((tag) => ({ tag, type: 'BT', status: 'warehouse', data: { tag, status: 'warehouse' } })));
});

const login = () => request(ctx.app).post('/api/auth/login').send({ username: 'a.one', password: 'Strong#Pass12' });
const me = (token: string) => request(ctx.app).get('/api/auth/me').set(auth(token));

describe('employee account control', () => {
  it('revoking signs out old tokens but allows a new sign-in', async () => {
    await request(ctx.app).put('/api/employees/A-1/credentials').set(auth(ctx.token)).send({ username: 'a.one', password: 'Strong#Pass12' });
    const first = (await login()).body.token;
    expect((await me(first)).status).toBe(200);
    expect((await request(ctx.app).post('/api/employees/A-1/revoke-sessions').set(auth(ctx.token))).status).toBe(200);
    expect((await me(first)).status).toBe(401);
    expect((await me((await login()).body.token)).status).toBe(200);
  });

  it('a suspended account cannot sign in or keep using a token', async () => {
    const token = (await login()).body.token;
    const patch = (active: boolean) => request(ctx.app).patch('/api/employees/A-1/account-status').set(auth(ctx.token)).send({ active });
    expect((await patch(false)).status).toBe(200);
    expect((await me(token)).status).toBe(401);
    expect((await login()).status).toBe(403);
    await patch(true);
    expect((await login()).status).toBe(200);
  });

  it('an ordinary employee cannot suspend anyone', async () => {
    const token = (await login()).body.token;
    const res = await request(ctx.app).patch('/api/employees/A-1/account-status').set(auth(token)).send({ active: false });
    expect(res.status).toBe(403);
    expect((await getDb().select().from(employees).where(eq(employees.id, 'A-1')))[0].accountActive).toBe(true);
  });
});

describe('FX9600 on a dedicated OUT gate', () => {
  const read = (gate: number, tag: string) =>
    request(ctx.app).post(`/api/rfid/fx9600/${gate}/webhook`).set('X-Webhook-Secret', env.fx9600WebhookSecret).send([{ data: { idHex: tag } }]);
  const stage = (gate: number, plate?: string) =>
    request(ctx.app).put(`/api/rfid/gates/${gate}/auto-session`).set(auth(ctx.token)).send({ direction: 'out', customer: 'C-1', plate });
  const status = async (tag: string) => (await getDb().select().from(boxes).where(eq(boxes.tag, tag)))[0].status;

  it('waits for the camera when a plate is staged, then ships on a match only', async () => {
    await stage(41, 'ZZ-1');
    await read(41, 'R-1');
    expect(await status('R-1')).toBe('warehouse');
    const lpr = (plate: string, id: string) => request(ctx.app).post('/api/gate/lpr').set('X-LPR-Webhook-Secret', env.lprWebhookSecret)
      .send({ eventId: id, cameraId: 'c', plateNumber: plate, confidence: 0.99, gateId: 41, timestamp: new Date().toISOString(), vehicleColor: 'w' });
    expect((await lpr('NO-9', 'r1')).body.action).toBe('manual_review');
    expect(await status('R-1')).toBe('warehouse');
    expect((await lpr('ZZ-1', 'r2')).body.action).toBe('open_gate');
    expect(await status('R-1')).toBe('out');
  });

  it('still ships at once when no plate is staged', async () => {
    await stage(42);
    await read(42, 'R-2');
    expect(await status('R-2')).toBe('out');
  });

  it('rejects a body it cannot parse', async () => {
    const res = await request(ctx.app).post('/api/rfid/fx9600/41/webhook').set('X-Webhook-Secret', env.fx9600WebhookSecret)
      .set('Content-Type', 'text/plain').send('not json at all');
    expect(res.status).toBe(400);
  });
});

// Last on purpose: it replaces the whole state, including the fixtures above.
describe('whole-state save', () => {
  it('a whole-state save keeps the suspension and revoked sessions', async () => {
    const row = async () => (await getDb().select().from(employees).where(eq(employees.id, 'A-1')))[0];
    await request(ctx.app).patch('/api/employees/A-1/account-status').set(auth(ctx.token)).send({ active: false });
    const before = await row();
    const state = (await request(ctx.app).get('/api/state').set(auth(ctx.token))).body;
    const saved = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(state.state ?? state);
    expect(saved.status).toBe(200);
    expect(await row()).toMatchObject({ accountActive: false, sessionVersion: before.sessionVersion });
    await request(ctx.app).patch('/api/employees/A-1/account-status').set(auth(ctx.token)).send({ active: true });
  });
});
