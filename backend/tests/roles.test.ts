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
    /* 409, not 403: the caller does hold permission.manage — what stops them is
       the state they would leave the system in (zero Super Admins), which is a
       conflict rather than a permissions failure. See the `conflict()` helper
       in routes/roles.ts. */
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Super Admin คนสุดท้าย');

    const [after] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(after.roleId).toBe(sa.id); // rejected — the account is untouched
  });
});

describe('missing vs null vs a real value on assign-employee', () => {
  /* undefined = "don't touch it" is meaningless for THIS endpoint — its only
     job is setting the role, so unlike PUT /api/state (a whole-record replace
     where an absent field really does mean unchanged), a request with no
     roleId key is malformed input, not "leave the role alone". This is what
     stops the bug that shipped before this fix: the employee form's role
     <select> renders disabled (and empty) whenever /api/roles fails to load,
     and the old handler read that empty value as "roleId: null" — clearing a
     role nobody asked to touch, from a save meant only to update a phone
     number. Requiring the key forces a 400 instead of a silent wipe. */
  it('rejects a request with no roleId key at all', async () => {
    const db = getDb();
    await db
      .insert(employees)
      .values({ id: 'TEST-RBAC-001', name: 'ทดสอบ RBAC หนึ่ง' })
      .onConflictDoNothing({ target: employees.id });
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const staff = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
    await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-001')
      .set(auth(ctx.token))
      .send({ roleId: staff.id });

    const res = await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-001')
      .set(auth(ctx.token))
      .send({}); // no roleId key — e.g. a general-info save that never touched the role field
    expect(res.status).toBe(400);

    const [emp] = await db.select().from(employees).where(eq(employees.id, 'TEST-RBAC-001'));
    expect(emp.roleId).toBe(staff.id); // untouched

    await db.delete(employees).where(eq(employees.id, 'TEST-RBAC-001'));
  });

  it('treats an explicit roleId: null as "remove the role", not an error', async () => {
    const db = getDb();
    await db
      .insert(employees)
      .values({ id: 'TEST-RBAC-002', name: 'ทดสอบ RBAC สอง' })
      .onConflictDoNothing({ target: employees.id });
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const staff = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
    await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-002')
      .set(auth(ctx.token))
      .send({ roleId: staff.id });

    const res = await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-002')
      .set(auth(ctx.token))
      .send({ roleId: null });
    expect(res.status).toBe(200);
    const [emp] = await db.select().from(employees).where(eq(employees.id, 'TEST-RBAC-002'));
    expect(emp.roleId).toBeNull();

    await db.delete(employees).where(eq(employees.id, 'TEST-RBAC-002'));
  });
});

describe('role changes are audited, general saves are not', () => {
  it('logs role_changed with before/after names when the role actually changes, and skips duplicates', async () => {
    const db = getDb();
    await db
      .insert(employees)
      .values({ id: 'TEST-RBAC-003', name: 'ทดสอบ RBAC สาม' })
      .onConflictDoNothing({ target: employees.id });
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const staff = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
    const viewer = list.body.roles.find((r: { key: string }) => r.key === 'viewer');

    await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-003')
      .set(auth(ctx.token))
      .send({ roleId: staff.id });
    await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-003')
      .set(auth(ctx.token))
      .send({ roleId: viewer.id });

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    const entries = (state.body.auditLog as Array<Record<string, unknown>>).filter(
      (a) => a.itemId === 'TEST-RBAC-003',
    );
    expect(entries.length).toBe(2); // one per real change — not per request
    expect(entries.some((e) => (e.after as string).includes(staff.name))).toBe(true);
    expect(entries.some((e) => (e.after as string).includes(viewer.name))).toBe(true);

    /* Re-sending the same role must not audit again — a duplicate save is not
       a role change. */
    await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-003')
      .set(auth(ctx.token))
      .send({ roleId: viewer.id });
    const state2 = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    const entries2 = (state2.body.auditLog as Array<Record<string, unknown>>).filter(
      (a) => a.itemId === 'TEST-RBAC-003',
    );
    expect(entries2.length).toBe(2);

    await db.delete(employees).where(eq(employees.id, 'TEST-RBAC-003'));
  });

  it('editing general fields through PUT /api/state never touches the role or its audit trail', async () => {
    const db = getDb();
    await db
      .insert(employees)
      .values({ id: 'TEST-RBAC-004', name: 'ทดสอบ RBAC สี่' })
      .onConflictDoNothing({ target: employees.id });
    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    const staff = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
    await request(ctx.app)
      .put('/api/roles/assign-employee/TEST-RBAC-004')
      .set(auth(ctx.token))
      .send({ roleId: staff.id });

    /* Editing only a phone number — including the shape the disabled <select>
       used to produce, roleId simply absent from the JSON body — must leave
       the stored role exactly as it was, and must not add a NEW role-change
       audit entry on top of the one from assigning it above. */
    const before = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    const beforeCount = (before.body.auditLog as Array<Record<string, unknown>>).filter(
      (a) => a.itemId === 'TEST-RBAC-004' && (a.action === 'role_changed' || a.action === 'role_removed'),
    ).length;
    expect(beforeCount).toBe(1); // the assign-employee call above did audit — that's correct

    await request(ctx.app)
      .put('/api/state')
      .set(auth(ctx.token))
      .send({ employees: { 'TEST-RBAC-004': { id: 'TEST-RBAC-004', name: 'ทดสอบ RBAC สี่', phone: '0812223333' } } });

    const [emp] = await db.select().from(employees).where(eq(employees.id, 'TEST-RBAC-004'));
    expect(emp.roleId).toBe(staff.id);

    const after = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    const afterCount = (after.body.auditLog as Array<Record<string, unknown>>).filter(
      (a) => a.itemId === 'TEST-RBAC-004' && (a.action === 'role_changed' || a.action === 'role_removed'),
    ).length;
    expect(afterCount).toBe(beforeCount); // unchanged — the phone edit added no role audit

    await db.delete(employees).where(eq(employees.id, 'TEST-RBAC-004'));
  });
});

describe('Super Admin cannot be lost through PUT /api/state either', () => {
  /* roleId itself can never arrive through this endpoint (see state.test.ts's
     "blob claiming Super Admin must not move the column" case) — what CAN
     happen here is the row disappearing (absent from the payload → pruned) or
     its employment status flipping away from 'active'. Both are covered.

     Each test moves the seed admin off Super Admin onto the built-in 'admin'
     role (all permissions, not the system role) rather than 'viewer' — the
     caller still needs employee.delete/employee.update to even reach the
     guard being tested; demoting to a role that can't make the request at all
     would only prove guardStatePayload's permission revert, not this guard.
     Wrapped in try/finally: an assertion failure must not leave the seed
     admin stuck off Super Admin for every test that runs after this one. */
  it('refuses to delete the last active Super Admin employee', async () => {
    const db = getDb();
    const [sa] = await db.select().from(roles).where(eq(roles.key, 'super_admin'));
    const [adminUser] = await db.select().from(users).where(eq(users.username, 'admin'));
    const [adminRole] = await db.select().from(roles).where(eq(roles.key, 'admin'));
    await db.update(users).set({ roleId: adminRole.id }).where(eq(users.id, adminUser.id));
    await db
      .insert(employees)
      .values({ id: 'TEST-RBAC-005', name: 'ทดสอบ RBAC ห้า', roleId: sa.id })
      .onConflictDoUpdate({ target: employees.id, set: { roleId: sa.id } });
    invalidateRoleCache();

    try {
      const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
      const employeesPayload = { ...state.body.employees };
      delete employeesPayload['TEST-RBAC-005'];

      const res = await request(ctx.app)
        .put('/api/state')
        .set(auth(ctx.token))
        .send({ employees: employeesPayload });
      expect(res.status).toBe(409);

      const [still] = await db.select().from(employees).where(eq(employees.id, 'TEST-RBAC-005'));
      expect(still).toBeTruthy();
    } finally {
      await db.update(users).set({ roleId: sa.id }).where(eq(users.id, adminUser.id));
      await db.delete(employees).where(eq(employees.id, 'TEST-RBAC-005'));
      invalidateRoleCache();
    }
  });

  it('refuses to disable (พ้นสภาพ) the last active Super Admin employee', async () => {
    const db = getDb();
    const [sa] = await db.select().from(roles).where(eq(roles.key, 'super_admin'));
    const [adminUser] = await db.select().from(users).where(eq(users.username, 'admin'));
    const [adminRole] = await db.select().from(roles).where(eq(roles.key, 'admin'));
    await db.update(users).set({ roleId: adminRole.id }).where(eq(users.id, adminUser.id));
    await db
      .insert(employees)
      .values({ id: 'TEST-RBAC-006', name: 'ทดสอบ RBAC หก', roleId: sa.id, data: { status: 'active' } })
      .onConflictDoUpdate({ target: employees.id, set: { roleId: sa.id, data: { status: 'active' } } });
    invalidateRoleCache();

    try {
      const res = await request(ctx.app)
        .put('/api/state')
        .set(auth(ctx.token))
        .send({ employees: { 'TEST-RBAC-006': { id: 'TEST-RBAC-006', name: 'ทดสอบ RBAC หก', status: 'inactive' } } });
      expect(res.status).toBe(409);

      const [still] = await db.select().from(employees).where(eq(employees.id, 'TEST-RBAC-006'));
      expect((still.data as Record<string, unknown>)?.status).toBe('active');
    } finally {
      await db.update(users).set({ roleId: sa.id }).where(eq(users.id, adminUser.id));
      await db.delete(employees).where(eq(employees.id, 'TEST-RBAC-006'));
      invalidateRoleCache();
    }
  });

  it('allows demoting one of two Super Admins, leaving the system with one', async () => {
    const db = getDb();
    const [sa] = await db.select().from(roles).where(eq(roles.key, 'super_admin'));
    await db
      .insert(employees)
      .values({ id: 'TEST-RBAC-007', name: 'ทดสอบ RBAC เจ็ด', roleId: sa.id })
      .onConflictDoUpdate({ target: employees.id, set: { roleId: sa.id } });
    invalidateRoleCache(); // seed admin (users) still holds Super Admin too — two holders now

    try {
      const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
      const staff = list.body.roles.find((r: { key: string }) => r.key === 'warehouse_staff');
      const res = await request(ctx.app)
        .put('/api/roles/assign-employee/TEST-RBAC-007')
        .set(auth(ctx.token))
        .send({ roleId: staff.id });
      expect(res.status).toBe(200);

      const [emp] = await db.select().from(employees).where(eq(employees.id, 'TEST-RBAC-007'));
      expect(emp.roleId).toBe(staff.id);
      const [adminUser] = await db.select().from(users).where(eq(users.username, 'admin'));
      expect(adminUser.roleId).toBe(sa.id); // the one remaining Super Admin, untouched
    } finally {
      await db.delete(employees).where(eq(employees.id, 'TEST-RBAC-007'));
      invalidateRoleCache();
    }
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
