import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { ALL_PERMISSIONS } from '../src/lib/permission-catalog.js';
import { signToken } from '../src/lib/jwt.js';
import { getDb } from '../src/db/client.js';
import { boxes, customers } from '../src/db/schema.js';

type DbRows<T> = { rows?: T[] };
type QaPrincipal = { permission: string | null; token: string };

let ctx: TestCtx;
let principals: QaPrincipal[] = [];
let legacyProfiles: Array<{ role: 'admin' | 'staff' | 'viewer'; token: string }> = [];
let noPermissionStaffToken = '';

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  await db.insert(boxes).values({ tag: 'QA-PRIVATE-BOX', status: 'warehouse', labeled: true, data: { tag: 'QA-PRIVATE-BOX', status: 'warehouse' } });
  await db.insert(customers).values({ id: 'QA-PRIVATE-CUSTOMER', name: 'QA Private Customer', data: { id: 'QA-PRIVATE-CUSTOMER', name: 'QA Private Customer' } });

  // These are synthetic identities in the per-test in-memory PGlite database.
  // They are deliberately not created in the running application database.
  const none = await db.execute(sql`
    INSERT INTO roles (key, name, description, active, system)
    VALUES ('qa_no_permission', 'QA: no permission', 'Ephemeral QA role', true, false)
    RETURNING id
  `);
  const noneRoleId = Number((none as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
  const emptyUser = await db.execute(sql`
    INSERT INTO users (username, password_hash, name, role, email, role_id)
    VALUES ('qa-no-permission', 'not-a-login-hash', 'QA No Permission', 'viewer', 'qa-none@example.test', ${noneRoleId})
    RETURNING id
  `);
  const emptyUserId = Number((emptyUser as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
  principals.push({ permission: null, token: signToken({ sub: emptyUserId, username: 'qa-no-permission', name: 'QA No Permission', role: 'viewer' }) });
  noPermissionStaffToken = signToken({ sub: emptyUserId, username: 'qa-no-permission', name: 'QA No Permission Staff Claim', role: 'staff' });

  const adminId = Number(((await db.execute(sql`SELECT id FROM users WHERE username='admin'`)) as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
  legacyProfiles.push({ role: 'admin', token: signToken({ sub: adminId, username: 'admin', name: 'Admin', role: 'admin' }) });
  for (const role of ['staff', 'viewer'] as const) {
    const username = `qa-legacy-${role}`;
    const inserted = await db.execute(sql`
      INSERT INTO users (username, password_hash, name, role, email)
      VALUES (${username}, 'not-a-login-hash', ${'QA legacy ' + role}, ${role}, ${username + '@example.test'})
      RETURNING id
    `);
    const userId = Number((inserted as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
    legacyProfiles.push({ role, token: signToken({ sub: userId, username, name: 'QA legacy ' + role, role }) });
  }
  const staffUserId = Number(((await db.execute(sql`SELECT id FROM users WHERE username='qa-legacy-staff'`)) as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
  const gateRole = await db.execute(sql`INSERT INTO roles (key,name,description,active,system) VALUES ('qa_gate_operator','QA gate operator','Gate grant probe',true,false) RETURNING id`);
  const gateRoleId = Number((gateRole as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
  await db.execute(sql`INSERT INTO role_permissions (role_id,permission) VALUES (${gateRoleId},'gate.out')`);
  await db.execute(sql`UPDATE users SET role_id=${gateRoleId} WHERE id=${staffUserId}`);
  legacyProfiles = legacyProfiles.map((profile) => profile.role === 'staff' ? { ...profile, token: signToken({ sub: staffUserId, username: 'qa-legacy-staff', name: 'QA legacy staff', role: 'staff' }) } : profile);

  for (const [index, permission] of ALL_PERMISSIONS.entries()) {
    const roleResult = await db.execute(sql`
      INSERT INTO roles (key, name, description, active, system)
      VALUES (${'qa_' + index}, ${'QA: ' + permission}, 'Ephemeral one-permission role', true, false)
      RETURNING id
    `);
    const roleId = Number((roleResult as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
    await db.execute(sql`INSERT INTO role_permissions (role_id, permission) VALUES (${roleId}, ${permission})`);
    const userResult = await db.execute(sql`
      INSERT INTO users (username, password_hash, name, role, email, role_id)
      VALUES (${'qa-user-' + index}, 'not-a-login-hash', ${'QA ' + permission}, 'viewer', ${'qa-' + index + '@example.test'}, ${roleId})
      RETURNING id
    `);
    const userId = Number((userResult as unknown as DbRows<{ id: number }>).rows?.[0]?.id);
    principals.push({
      permission,
      token: signToken({ sub: userId, username: 'qa-user-' + index, name: 'QA ' + permission, role: 'viewer' }),
    });
  }
});

describe('Permission QA — ephemeral user per permission (52 rights)', () => {
  it('publishes a unique catalog of 52 permission keys', async () => {
    const result = await request(ctx.app).get('/api/roles/permissions').set(auth(principals[0]!.token));
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(52);
    const keys = result.body.modules.flatMap((module: { permissions: Array<{ key: string }> }) => module.permissions.map((item) => item.key));
    expect(new Set(keys).size).toBe(52);
    expect(keys).toEqual(ALL_PERMISSIONS);
  });

  for (const permission of ALL_PERMISSIONS) {
    it(`effective identity grants only ${permission}`, async () => {
      const principal = principals.find((item) => item.permission === permission)!;
      const result = await request(ctx.app).get('/api/roles/me').set(auth(principal.token));
      expect(result.status).toBe(200);
      expect(result.body.active).toBe(true);
      expect(result.body.permissions).toEqual([permission]);
    });
  }

  for (const principalPermission of ALL_PERMISSIONS) {
    it(`GET box inventory denies ${principalPermission} when box.view is absent`, async () => {
      const principal = principals.find((item) => item.permission === principalPermission)!;
      const result = await request(ctx.app).get('/api/boxes').set(auth(principal.token));
      const expected = principalPermission === 'box.view' ? 200 : 403;
      expect(result.status, `GET /api/boxes for one-permission role ${principalPermission}`).toBe(expected);
    });
  }

  const protectedReadCases: Array<{ path: string; allowed: string[]; label: string }> = [
    { path: '/api/masters/customers', allowed: ['partner.view', 'master.manage', 'setting.view'], label: 'partner records' },
    { path: '/api/masters/locations', allowed: ['warehouse.view', 'warehouse.manage', 'master.manage'], label: 'warehouse locations' },
    { path: '/api/masters/box-types', allowed: ['master.manage', 'setting.view', 'box.view', 'partner.view', 'warehouse.view'], label: 'box type masters' },
    { path: '/api/cycle-counts', allowed: ['cycle_count.view', 'cycle_count.manage'], label: 'cycle-count sessions' },
    { path: '/api/devices', allowed: ['device.manage', 'setting.view'], label: 'registered devices' },
    { path: '/api/rfid/fx9600/readers', allowed: ['rfid.log', 'rfid.manage', 'device.manage'], label: 'RFID readers' },
  ];
  for (const testCase of protectedReadCases) {
    for (const principalPermission of ALL_PERMISSIONS) {
      it(`GET ${testCase.label} checks ${principalPermission}`, async () => {
        const principal = principals.find((item) => item.permission === principalPermission)!;
        const result = await request(ctx.app).get(testCase.path).set(auth(principal.token));
        expect(result.status, `${testCase.path} for ${principalPermission}`).toBe(testCase.allowed.includes(principalPermission) ? 200 : 403);
      });
    }
  }

  it('denies full application snapshot access to a user with no permissions', async () => {
    const principal = principals.find((item) => item.permission === null)!;
    const result = await request(ctx.app).get('/api/state').set(auth(principal.token));
    expect(result.status, 'GET /api/state for empty-permission role').toBe(403);
  });

  it('does not let a legacy staff claim bypass state-write permissions', async () => {
    const result = await request(ctx.app).put('/api/state').set(auth(noPermissionStaffToken)).send({ boxes: {}, customers: {} });
    expect(result.status).toBe(403);
  });

  it('scopes snapshot data to the user permission set (box viewers do not receive partner/employee/audit data)', async () => {
    const principal = principals.find((item) => item.permission === 'box.view')!;
    const result = await request(ctx.app).get('/api/state').set(auth(principal.token));
    expect(result.status).toBe(200);
    expect(result.body.boxes['QA-PRIVATE-BOX']).toBeTruthy();
    expect(result.body.customers).toEqual({});
    expect(result.body.employees).toEqual({});
    expect(result.body.auditLog).toEqual([]);
  });

  it('denies role-management data to a user with no role/permission grants', async () => {
    const principal = principals.find((item) => item.permission === null)!;
    const result = await request(ctx.app).get('/api/roles/summary').set(auth(principal.token));
    expect(result.status).toBe(403);
  });

  it('applies baseline authentication roles to a harmless gate validation probe', async () => {
    const expected: Record<string, number> = { admin: 400, staff: 400, viewer: 403 };
    for (const profile of legacyProfiles) {
      const result = await request(ctx.app).post('/api/gate/out').set(auth(profile.token)).send({});
      expect(result.status, `POST /api/gate/out for ${profile.role}`).toBe(expected[profile.role]);
    }
  });

  it('provisions role-management access for the admin account', async () => {
    const admin = legacyProfiles.find((profile) => profile.role === 'admin')!;
    const result = await request(ctx.app).get('/api/roles/summary').set(auth(admin.token));
    expect(result.status, 'admin should have role.manage / permission.manage grants').toBe(200);
  });
});
