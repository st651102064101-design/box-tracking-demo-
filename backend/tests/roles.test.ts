/**
 * RBAC — Role & Permission API and the enforcement it drives.
 *
 * The point of these tests is the half that isn't visible on screen: hiding a
 * button in the UI is a courtesy, so what matters is that a role without a
 * permission is refused when it calls the endpoint directly.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { users, roles, employees } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { invalidateRoleCache } from '../src/lib/effectivePermissions.js';
import { ALL_PERMISSIONS } from '../src/lib/permissions.js';
import { eq } from 'drizzle-orm';

let ctx: TestCtx;
/** A signed-in account on the seeded "เจ้าหน้าที่คลัง" role — can register a
 *  box, must not be able to delete master data or manage roles. */
let staffToken: string;

async function loginAs(username: string, password: string) {
  const res = await request(ctx.app).post('/api/auth/login').send({ username, password });
  return res.body.token as string;
}

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  const [staffRole] = await db.select().from(roles).where(eq(roles.key, 'warehouse_staff'));
  await db.insert(users).values({
    username: 'somchai',
    passwordHash: await hashPassword('staff123'),
    name: 'สมชาย',
    role: 'staff',
    roleId: staffRole.id,
  });
  invalidateRoleCache();
  staffToken = await loginAs('somchai', 'staff123');
});

describe('permission catalog', () => {
  it('serves the developer-defined catalog, and admins cannot add to it', async () => {
    const res = await request(ctx.app).get('/api/roles/permissions').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(ALL_PERMISSIONS.length);
    const keys = res.body.modules.flatMap((m: { permissions: { key: string }[] }) =>
      m.permissions.map((p) => p.key),
    );
    expect(keys).toContain('box.delete');
    expect(keys).toContain('role.manage');

    /* A made-up permission is silently dropped rather than stored — a key no
       route checks would render as a checkbox that grants nothing. */
    const created = await request(ctx.app)
      .post('/api/roles')
      .set(auth(ctx.token))
      .send({ name: 'ทดสอบ Permission ปลอม', permissions: ['box.view', 'box.teleport'] });
    expect(created.status).toBe(201);
    expect(created.body.permissions).toEqual(['box.view']);
  });
});

describe('role CRUD', () => {
  it('creates, edits and deletes a role', async () => {
    const created = await request(ctx.app)
      .post('/api/roles')
      .set(auth(ctx.token))
      .send({ name: 'หัวหน้ากะกลางคืน', description: 'กะดึก', permissions: ['box.view'] });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const edited = await request(ctx.app)
      .put(`/api/roles/${id}`)
      .set(auth(ctx.token))
      .send({ description: 'กะดึก 22:00–06:00', active: false, permissions: ['box.view', 'box.print'] });
    expect(edited.status).toBe(200);
    expect(edited.body.active).toBe(false);
    expect(edited.body.permissions.sort()).toEqual(['box.print', 'box.view']);

    const gone = await request(ctx.app).delete(`/api/roles/${id}`).set(auth(ctx.token));
    expect(gone.status).toBe(200);
  });

  it('refuses a duplicate role name', async () => {
    await request(ctx.app).post('/api/roles').set(auth(ctx.token)).send({ name: 'ซ้ำได้ไหม' });
    const dup = await request(ctx.app)
      .post('/api/roles')
      .set(auth(ctx.token))
      .send({ name: 'ซ้ำได้ไหม' });
    expect(dup.status).toBe(409);
  });

  it('refuses to delete a role that still has members', async () => {
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const staffRole = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
    expect(staffRole.members).toBeGreaterThan(0);

    const res = await request(ctx.app).delete(`/api/roles/${staffRole.id}`).set(auth(ctx.token));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('role_in_use');
    expect(res.body.message).toContain(`${staffRole.members} คน`);

    /* …and the UI's "ดูพนักงานที่ใช้งาน" has something to open. */
    const members = await request(ctx.app)
      .get(`/api/roles/${staffRole.id}/members`)
      .set(auth(ctx.token));
    expect(members.body.members.map((m: { username: string }) => m.username)).toContain('somchai');
  });
});

describe('Super Admin is locked', () => {
  it('cannot be edited, disabled, stripped or deleted', async () => {
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const sa = list.body.roles.find((r: { key: string }) => r.key === 'super_admin');
    expect(sa.system).toBe(true);
    expect(sa.permissions.length).toBe(ALL_PERMISSIONS.length);

    const edit = await request(ctx.app)
      .put(`/api/roles/${sa.id}`)
      .set(auth(ctx.token))
      .send({ active: false, permissions: [] });
    expect(edit.status).toBe(403);

    const del = await request(ctx.app).delete(`/api/roles/${sa.id}`).set(auth(ctx.token));
    expect(del.status).toBe(403);
  });

  it('will not let the last Super Admin demote themselves', async () => {
    const db = getDb();
    const [admin] = await db.select().from(users).where(eq(users.username, 'admin'));
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const sa = list.body.roles.find((r: { key: string }) => r.key === 'super_admin');
    const viewer = list.body.roles.find((r: { key: string }) => r.key === 'viewer');

    /* Put the only account that could do it onto Super Admin first — this is
       the shape a real install has after seed.ts. */
    await db.update(users).set({ roleId: sa.id }).where(eq(users.id, admin.id));
    invalidateRoleCache();

    const res = await request(ctx.app)
      .put(`/api/roles/assign/${admin.id}`)
      .set(auth(ctx.token))
      .send({ roleId: viewer.id });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('Super Admin คนสุดท้าย');
  });
});

describe('enforcement — a hidden button is not the boundary', () => {
  it('lets warehouse staff do their job', async () => {
    const me = await request(ctx.app).get('/api/auth/me').set(auth(staffToken));
    expect(me.body.role.name).toBe('เจ้าหน้าที่คลัง');
    expect(me.body.permissions).toContain('box.create');
    expect(me.body.permissions).not.toContain('role.manage');
  });

  it('refuses master-data and role management with 403 + a Thai message', async () => {
    const master = await request(ctx.app)
      .post('/api/masters/box-types')
      .set(auth(staffToken))
      .send({ id: 'BT-X', name: 'ทดสอบ', unit: 'ใบ' });
    expect(master.status).toBe(403);
    expect(master.body.message).toBe('คุณไม่มีสิทธิ์ดำเนินการนี้');

    const rolesList = await request(ctx.app).get('/api/roles').set(auth(staffToken));
    expect(rolesList.status).toBe(403);

    const makeRole = await request(ctx.app)
      .post('/api/roles')
      .set(auth(staffToken))
      .send({ name: 'ตั้งบทบาทเอง' });
    expect(makeRole.status).toBe(403);
  });

  it('stops granting anything the moment a role is switched off', async () => {
    const db = getDb();
    const [staffRole] = await db.select().from(roles).where(eq(roles.key, 'warehouse_staff'));
    await db.update(roles).set({ active: false }).where(eq(roles.id, staffRole.id));
    invalidateRoleCache();

    const res = await request(ctx.app)
      .post('/api/boxes')
      .set(auth(staffToken))
      .send({ tag: 'BOX-RBAC-1', type: 'BT-1' });
    expect(res.status).toBe(403);

    await db.update(roles).set({ active: true }).where(eq(roles.id, staffRole.id));
    invalidateRoleCache();
  });
});

describe('employees carry their own role', () => {
  it('applies a role to an employee with no users row, and state saves cannot change it', async () => {
    const db = getDb();
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const staff = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
    const sa = list.body.roles.find((r: { key: string }) => r.key === 'super_admin');

    /* An employee record with no linked account at all — the common case, and
       the one that used to end up with no permissions whatsoever. */
    await request(ctx.app)
      .put('/api/state')
      .set(auth(ctx.token))
      .send({ employees: { 'EMP-900': { id: 'EMP-900', name: 'สมหญิง' } } });

    const assigned = await request(ctx.app)
      .put('/api/roles/assign-employee/EMP-900')
      .set(auth(ctx.token))
      .send({ roleId: staff.id });
    expect(assigned.status).toBe(200);

    const [emp] = await db.select().from(employees).where(eq(employees.id, 'EMP-900'));
    expect(emp.roleId).toBe(staff.id);
    /* PUT /api/state links a new employee to the account that saved it, so the
       admin's own account must be left exactly where it was — giving a new hire
       a junior role must not demote whoever created them. */
    const [me] = await db.select().from(users).where(eq(users.username, 'admin'));
    const [saRole] = await db.select().from(roles).where(eq(roles.key, 'super_admin'));
    expect(me.roleId).toBe(saRole.id);

    /* The blob claiming Super Admin must not move the column — otherwise
       "save the app state" would be a privilege-escalation endpoint. */
    await request(ctx.app)
      .put('/api/state')
      .set(auth(ctx.token))
      .send({ employees: { 'EMP-900': { id: 'EMP-900', name: 'สมหญิง', roleId: sa.id } } });

    const [after] = await db.select().from(employees).where(eq(employees.id, 'EMP-900'));
    expect(after.roleId).toBe(staff.id);

    /* …and the state the UI reads back shows the column, not the blob's copy. */
    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.employees['EMP-900'].roleId).toBe(staff.id);
  });

  it('counts employees as members, so their role cannot be deleted underneath them', async () => {
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const staff = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
    expect(staff.members).toBeGreaterThanOrEqual(2); // somchai (users) + EMP-900 (employees)

    const del = await request(ctx.app).delete(`/api/roles/${staff.id}`).set(auth(ctx.token));
    expect(del.status).toBe(409);

    const members = await request(ctx.app)
      .get(`/api/roles/${staff.id}/members`)
      .set(auth(ctx.token));
    expect(members.body.members.map((m: { employeeId: string }) => m.employeeId)).toContain('EMP-900');
  });

  it('lets a role be cleared back to none', async () => {
    const res = await request(ctx.app)
      .put('/api/roles/assign-employee/EMP-900')
      .set(auth(ctx.token))
      .send({ roleId: null });
    expect(res.status).toBe(200);
    const [emp] = await getDb().select().from(employees).where(eq(employees.id, 'EMP-900'));
    expect(emp.roleId).toBeNull();
  });
});
