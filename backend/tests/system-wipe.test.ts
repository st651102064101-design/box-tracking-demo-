/**
 * POST /api/system/wipe — Full System Wipe.
 *
 * Protected identity is role-based (super_admin), not a hardcoded employee
 * id — see systemWipe.ts's header comment. These tests deliberately use an
 * employee id that is NOT "EMP-001" to prove the wipe doesn't secretly key
 * off that string.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import {
  employees,
  roles,
  boxes,
  customers,
  auditLog,
  sequences,
  users,
} from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { invalidateRoleCache } from '../src/lib/effectivePermissions.js';

let ctx: TestCtx;
/** A logged-in account that actually holds `super_admin` — the seeded
 *  bootstrap "admin" user from helpers.ts backfills onto the plain 'admin'
 *  role (see permissions.ts roleKeyForLegacy), NOT super_admin, same as
 *  branding.test.ts already has to work around. */
let superToken: string;

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  const [superRole] = await db.select().from(roles).where(eq(roles.key, 'super_admin'));
  await db.insert(users).values({
    username: 'wipe-super',
    passwordHash: await hashPassword('super123'),
    name: 'Wipe Super Admin',
    role: 'admin',
    roleId: superRole.id,
  });
  invalidateRoleCache();
  const login = await request(ctx.app).post('/api/auth/login').send({ username: 'wipe-super', password: 'super123' });
  superToken = login.body.token;
});

async function superAdminRoleId(): Promise<number> {
  const db = getDb();
  const [row] = await db.select().from(roles).where(eq(roles.key, 'super_admin'));
  return row.id;
}

describe('POST /api/system/wipe', () => {
  it('keeps every employee holding super_admin (whatever their id), deletes the rest', async () => {
    const db = getDb();
    const roleId = await superAdminRoleId();
    const [staffRole] = await db.select().from(roles).where(eq(roles.key, 'warehouse_staff'));

    // Deliberately not "EMP-001" — the protected one this time is EMP-007.
    await db.insert(employees).values([
      { id: 'EMP-007', name: 'สมชาย', roleId, username: 'somchai', passwordHash: await hashPassword('x') },
      { id: 'EMP-002', name: 'วิไล', roleId: staffRole.id },
      { id: 'EMP-003', name: 'อนันต์', roleId: staffRole.id },
    ]);

    const res = await request(ctx.app).post('/api/system/wipe').set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.body.keptEmployeeIds).toEqual(['EMP-007']);

    const rows = await db.select().from(employees);
    expect(rows.map((r) => r.id)).toEqual(['EMP-007']);
  });

  it('resets a kept super_admin employee profile but preserves id/login/role', async () => {
    const db = getDb();
    const roleId = await superAdminRoleId();
    const pwHash = await hashPassword('keepme123');
    await db.insert(employees).values({
      id: 'EMP-008',
      name: 'ชื่อที่ถูกแก้ไข',
      roleId,
      username: 'wichai',
      passwordHash: pwHash,
      data: { email: 'wichai@example.com', phone: '0812345678', photo: 'data:...', dept: 'IT' },
    });

    const res = await request(ctx.app).post('/api/system/wipe').set(auth(superToken));
    expect(res.status).toBe(200);

    const [row] = await db.select().from(employees).where(eq(employees.id, 'EMP-008'));
    expect(row).toBeTruthy();
    expect(row.name).not.toBe('ชื่อที่ถูกแก้ไข');
    expect(row.data).toEqual({ access: 'admin' });
    expect(row.roleId).toBe(roleId); // still super_admin
    expect(row.username).toBe('wichai'); // login preserved
    expect(row.passwordHash).toBe(pwHash); // password not rotated

    // and that preserved login can still authenticate
    const loginRes = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'wichai', password: 'keepme123' });
    expect(loginRes.status).toBe(200);
  });

  it('bootstrap users/admin account is untouched and can still log in', async () => {
    const res = await request(ctx.app).post('/api/system/wipe').set(auth(superToken));
    expect(res.status).toBe(200);

    const loginRes = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    expect(loginRes.status).toBe(200);
  });

  it('deletes operational data: boxes, customers', async () => {
    const db = getDb();
    await db.insert(boxes).values({ tag: 'CRT-01', status: 'warehouse' });
    await db.insert(customers).values({ id: 'CUST-01', name: 'ลูกค้า A' });

    const res = await request(ctx.app).post('/api/system/wipe').set(auth(superToken));
    expect(res.status).toBe(200);

    expect(await db.select().from(boxes)).toHaveLength(0);
    expect(await db.select().from(customers)).toHaveLength(0);
  });

  it('clears the audit log, then writes exactly one fresh entry for the wipe itself', async () => {
    const db = getDb();
    await db.insert(auditLog).values({ action: 'box_created', actor: 'someone', entityId: 'CRT-01' });

    const res = await request(ctx.app).post('/api/system/wipe').set(auth(superToken));
    expect(res.status).toBe(200);

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('system_wipe');
  });

  it('sets the emp sequence past the highest kept employee number, not to zero', async () => {
    const db = getDb();
    const roleId = await superAdminRoleId();
    await db.insert(employees).values({ id: 'EMP-012', name: 'A', roleId });

    const res = await request(ctx.app).post('/api/system/wipe').set(auth(superToken));
    expect(res.status).toBe(200);

    const [seq] = await db.select().from(sequences).where(eq(sequences.name, 'emp'));
    expect(seq.value).toBe(12);
  });

  it('rejects a non-super-admin caller and leaves data untouched', async () => {
    const db = getDb();
    const [staffRole] = await db.select().from(roles).where(eq(roles.key, 'warehouse_staff'));
    await db.insert(users).values({
      username: 'staffuser',
      passwordHash: await hashPassword('staff123'),
      name: 'Staff',
      role: 'staff',
      roleId: staffRole.id,
    });
    await db.insert(boxes).values({ tag: 'CRT-01', status: 'warehouse' });

    const loginRes = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'staffuser', password: 'staff123' });
    const staffToken = loginRes.body.token as string;

    const res = await request(ctx.app).post('/api/system/wipe').set(auth(staffToken));
    expect(res.status).toBe(403);

    expect(await db.select().from(boxes)).toHaveLength(1);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(ctx.app).post('/api/system/wipe');
    expect(res.status).toBe(401);
  });

  it('works when no employee holds super_admin — leaves employees empty, bootstrap login still fine', async () => {
    const db = getDb();
    // Earlier tests in this file leave their own super_admin-holding employees
    // behind on purpose (that's the invariant under test) — clear the slate
    // first so this scenario ("nobody but the bootstrap `users` account holds
    // super_admin") is actually true when the wipe runs.
    await db.delete(employees);
    const [staffRole] = await db.select().from(roles).where(eq(roles.key, 'warehouse_staff'));
    await db.insert(employees).values({ id: 'EMP-999', name: 'ไม่ใช่ super admin', roleId: staffRole.id });

    const res = await request(ctx.app).post('/api/system/wipe').set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.body.keptEmployeeIds).toEqual([]);

    expect(await db.select().from(employees)).toHaveLength(0);

    const loginRes = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    expect(loginRes.status).toBe(200);
  });
});
