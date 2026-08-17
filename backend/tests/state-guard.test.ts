/**
 * PUT /api/state — per-entity permission enforcement.
 *
 * The bridge takes the whole `S` blob, so the interesting cases are all about
 * the diff: an untouched table must not need a permission, and a touched one
 * must not go through without it — including the case that actually loses
 * data, which is a stale or hostile client uploading a snapshot with rows
 * missing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { users, roles } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { invalidateRoleCache } from '../src/lib/effectivePermissions.js';
import { eq } from 'drizzle-orm';

let ctx: TestCtx;
let staffToken: string; // เจ้าหน้าที่คลัง — boxes yes, master data / employees no
let viewerToken: string; // Viewer — read only

const BASE = {
  boxes: {
    'BOX-1': { tag: 'BOX-1', type: 'BT-1', status: 'warehouse' },
    'BOX-2': { tag: 'BOX-2', type: 'BT-1', status: 'warehouse' },
  },
  boxtypes: { 'BT-1': { id: 'BT-1', name: 'ลังพลาสติก', unit: 'ใบ' } },
  customers: { 'CUST-1': { id: 'CUST-1', name: 'บจก. ส1' } },
  employees: { 'EMP-1': { id: 'EMP-1', name: 'สมชาย' } },
};

async function login(username: string, password: string) {
  const res = await request(ctx.app).post('/api/auth/login').send({ username, password });
  return res.body.token as string;
}

async function state(token: string) {
  return (await request(ctx.app).get('/api/state').set(auth(token))).body;
}

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  for (const [username, key, name] of [
    ['staff1', 'warehouse_staff', 'สมชาย'],
    ['viewer1', 'viewer', 'สมหญิง'],
  ] as const) {
    const [role] = await db.select().from(roles).where(eq(roles.key, key));
    await db.insert(users).values({
      username,
      passwordHash: await hashPassword('pass1234'),
      name,
      role: 'staff',
      roleId: role.id,
    });
  }
  invalidateRoleCache();
  staffToken = await login('staff1', 'pass1234');
  viewerToken = await login('viewer1', 'pass1234');

  // Seed a known baseline as the admin, who may write everything.
  await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(BASE);
});

describe('untouched groups need no permission', () => {
  it('lets staff save a box edit even though the snapshot also carries employees and master data', async () => {
    const s = await state(staffToken);
    s.boxes['BOX-1'].status = 'out'; // the one thing they are changing

    const res = await request(ctx.app).put('/api/state').set(auth(staffToken)).send(s);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([]);

    const after = await state(ctx.token);
    expect(after.boxes['BOX-1'].status).toBe('out');
  });
});

describe('touched groups need the matching permission', () => {
  it('refuses an employee edit from staff, and keeps the stored version', async () => {
    const s = await state(staffToken);
    s.employees['EMP-1'].name = 'ชื่อที่ไม่ควรเปลี่ยนได้';

    const res = await request(ctx.app).put('/api/state').set(auth(staffToken)).send(s);
    expect(res.status).toBe(200);
    expect(res.body.rejected.map((r: { key: string }) => r.key)).toContain('employees');

    const after = await state(ctx.token);
    expect(after.employees['EMP-1'].name).toBe('สมชาย');
  });

  it('refuses master-data changes from staff', async () => {
    const s = await state(staffToken);
    s.boxtypes['BT-1'].name = 'เปลี่ยนชื่อประเภทกล่อง';
    s.cfg = { ...s.cfg, agingDays: 99 };

    const res = await request(ctx.app).put('/api/state').set(auth(staffToken)).send(s);
    expect(res.body.rejected.map((r: { key: string }) => r.key)).toContain('master');

    const after = await state(ctx.token);
    expect(after.boxtypes['BT-1'].name).toBe('ลังพลาสติก');
    expect(after.cfg.agingDays).not.toBe(99);
  });

  it('applies the allowed half of a mixed save and refuses the rest', async () => {
    const s = await state(staffToken);
    s.boxes['BOX-2'].status = 'out'; // allowed
    s.customers['CUST-1'].name = 'ชื่อใหม่'; // not allowed (no partner.update)

    const res = await request(ctx.app).put('/api/state').set(auth(staffToken)).send(s);
    expect(res.body.rejected.map((r: { key: string }) => r.key)).toEqual(['partners']);

    const after = await state(ctx.token);
    expect(after.boxes['BOX-2'].status).toBe('out');
    expect(after.customers['CUST-1'].name).toBe('บจก. ส1');
  });
});

describe('the case that actually loses data', () => {
  it('will not let a viewer wipe tables by uploading a snapshot with rows missing', async () => {
    const s = await state(viewerToken);
    delete s.boxes['BOX-1'];
    delete s.customers['CUST-1'];
    delete s.employees['EMP-1'];
    s.boxtypes = {};

    const res = await request(ctx.app).put('/api/state').set(auth(viewerToken)).send(s);
    expect(res.status).toBe(200);
    expect(res.body.rejected.map((r: { key: string }) => r.key).sort()).toEqual([
      'boxes',
      'employees',
      'master',
      'partners',
    ]);

    const after = await state(ctx.token);
    expect(Object.keys(after.boxes)).toHaveLength(2);
    expect(after.customers['CUST-1']).toBeTruthy();
    expect(after.employees['EMP-1']).toBeTruthy();
    expect(after.boxtypes['BT-1']).toBeTruthy();
  });

  it('refuses a staff box DELETE while allowing a staff box edit', async () => {
    const del = await state(staffToken);
    delete del.boxes['BOX-2'];
    const res = await request(ctx.app).put('/api/state').set(auth(staffToken)).send(del);
    expect(res.body.rejected.map((r: { key: string }) => r.key)).toContain('boxes');

    const after = await state(ctx.token);
    expect(after.boxes['BOX-2']).toBeTruthy();
  });
});

describe('admins still write everything', () => {
  it('reports nothing rejected for a full-permission account', async () => {
    const s = await state(ctx.token);
    s.employees['EMP-2'] = { id: 'EMP-2', name: 'พนักงานใหม่' };
    s.boxtypes['BT-2'] = { id: 'BT-2', name: 'ลังไม้', unit: 'ใบ' };

    const res = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(s);
    expect(res.body.rejected).toEqual([]);

    const after = await state(ctx.token);
    expect(after.employees['EMP-2']).toBeTruthy();
    expect(after.boxtypes['BT-2']).toBeTruthy();
  });
});
