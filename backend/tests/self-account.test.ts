import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { employees, roles, users } from '../src/db/schema.js';
import { invalidateRoleCache } from '../src/lib/effectivePermissions.js';

let ctx: TestCtx;
let me: string; // token of employee Super Admin E-ME
let adminUserId: number;
const role: Record<string, number> = {};
const api = () => request(ctx.app);
const get = async (token: string) => (await api().get('/api/state').set(auth(token))).body;
const put = (token: string, state: object) => api().put('/api/state').set(auth(token)).send(state);
const row = async (id: string) => (await getDb().select().from(employees).where(eq(employees.id, id)))[0];
const login = (username: string) => api().post('/api/auth/login').send({ username, password: 'Strong#Pass12' });

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  (await db.select().from(roles)).forEach((r) => { role[r.key] = r.id; });
  adminUserId = (await db.select().from(users).where(eq(users.username, 'admin')))[0].id;
  await db.insert(employees).values([
    { id: 'E-LINK', name: 'linked to admin', userId: adminUserId, roleId: role.super_admin, data: { id: 'E-LINK', name: 'linked to admin', status: 'active', access: 'admin' } },
    { id: 'E-ME', name: 'me', roleId: role.super_admin, data: { id: 'E-ME', name: 'me', status: 'active', access: 'admin' } },
    { id: 'E-OTHER', name: 'other', data: { id: 'E-OTHER', name: 'other', status: 'active', access: 'operator' } },
  ]);
  await api().put('/api/employees/E-ME/credentials').set(auth(ctx.token)).send({ username: 'me.user', password: 'Strong#Pass12' });
  await api().put('/api/employees/E-OTHER/credentials').set(auth(ctx.token)).send({ username: 'other.user', password: 'Strong#Pass12' });
  me = (await login('me.user')).body.token;
});

describe('the server says who "me" is', () => {
  it('lists the employee records that are the caller', async () => {
    expect((await api().get('/api/auth/me').set(auth(me))).body.selfEmployeeIds).toEqual(['E-ME']);
    expect((await api().get('/api/auth/me').set(auth(ctx.token))).body.selfEmployeeIds).toEqual(['E-LINK']);
  });
});

describe.each([['an employee account', 'E-ME'], ['a system account on its linked record', 'E-LINK']])('%s cannot change itself', (_label, id) => {
  const token = () => (id === 'E-ME' ? me : ctx.token);

  it.each([['status', 'inactive'], ['status', 'leave'], ['access', 'viewer']])('keeps own %s (tried %s)', async (field, value) => {
    const state = await get(token());
    state.employees[id][field] = value;
    state.employees[id].phone = '0812345678';
    const res = await put(token(), state);
    expect(res.status).toBe(200);
    expect(res.body.rejected.map((r: { key: string }) => r.key)).toContain('self');
    const saved = (await row(id)).data as Record<string, unknown>;
    expect(saved[field]).not.toBe(value);
    expect(saved.phone).toBe('0812345678'); // ordinary profile edits still save
  });

  it('cannot delete or unlink itself', async () => {
    const state = await get(token());
    delete state.employees[id];
    await put(token(), state);
    expect(await row(id)).toBeDefined();
    const again = await get(token());
    again.employees['E-LINK'].userId = null;
    await put(token(), again);
    expect((await row('E-LINK')).userId).toBe(adminUserId);
  });

  it('cannot change or remove own role', async () => {
    for (const roleId of [role.viewer, null]) {
      const res = await api().put(`/api/roles/assign-employee/${id}`).set(auth(token())).send({ roleId });
      expect(res.status).toBe(403);
    }
    expect((await row(id)).roleId).toBe(role.super_admin);
    // re-sending the same role (the employee form does this) is fine
    expect((await api().put(`/api/roles/assign-employee/${id}`).set(auth(token())).send({ roleId: role.super_admin })).status).toBe(200);
  });

  it('cannot suspend itself', async () => {
    const res = await api().patch(`/api/employees/${id}/account-status`).set(auth(token())).send({ active: false });
    expect(res.status).toBe(409);
  });
});

describe('own system account and own role', () => {
  it('cannot change the role of the signed-in system account', async () => {
    expect((await api().put(`/api/roles/assign/${adminUserId}`).set(auth(ctx.token)).send({ roleId: role.viewer })).status).toBe(403);
    expect((await api().patch(`/api/auth/users/${adminUserId}/role`).set(auth(ctx.token)).send({ role: 'viewer' })).status).toBe(403);
  });

  it('cannot disable own role or take management rights from it', async () => {
    await getDb().update(employees).set({ roleId: role.admin }).where(eq(employees.id, 'E-ME'));
    invalidateRoleCache();
    const perms: string[] = (await api().get('/api/auth/me').set(auth(me))).body.permissions;
    const update = (body: object) => api().put(`/api/roles/${role.admin}`).set(auth(me)).send(body);
    expect((await update({ active: false })).status).toBe(403);
    for (const lost of ['role.manage', 'permission.manage']) {
      expect((await update({ permissions: perms.filter((p) => p !== lost) })).status).toBe(403);
    }
    expect((await update({ description: 'still editable' })).status).toBe(200);
    await getDb().update(employees).set({ roleId: role.super_admin }).where(eq(employees.id, 'E-ME'));
    invalidateRoleCache();
  });
});

describe('an employee who is not working cannot use the system', () => {
  beforeEach(async () => {
    const r = await row('E-OTHER');
    await getDb().update(employees).set({ data: { ...(r.data as object), status: 'active' } }).where(eq(employees.id, 'E-OTHER'));
  });

  it.each(['inactive', 'leave'])('%s: no sign-in, and the open session ends', async (status) => {
    const token = (await login('other.user')).body.token;
    const state = await get(ctx.token);
    state.employees['E-OTHER'].status = status;
    expect((await put(ctx.token, state)).status).toBe(200);
    expect((await api().get('/api/auth/me').set(auth(token))).status).toBe(401);
    expect((await login('other.user')).status).toBe(403);
  });
});
