import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users, employees, auditLog } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { writeAuditLog } from '../services/audit.js';
import { signToken } from '../lib/jwt.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import {
  loginSchema,
  registerSchema,
  updateRoleSchema,
  firstSetupSchema,
  linkEmployeeSchema,
} from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { isWorking } from '../lib/session.js';
import { isOwnUserAccount, selfEmployeeIds } from '../services/selfRules.js';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';

export const authRouter = Router();

/** Maps a `users.role` to the legacy `S.employees[x].data.access` level, so the
 *  two role vocabularies stay in sync instead of drifting independently. */
const ACCESS_BY_ROLE: Record<string, string> = { admin: 'admin', staff: 'operator', viewer: 'viewer' };

/** The inverse — an employee's `access` level (operator/supervisor/admin/viewer,
 *  the richer legacy vocabulary shown in the UI) collapses to the coarser
 *  admin/staff/viewer set for the JWT `role` claim, since that's what
 *  requireRole() on /api/masters, /api/gate, /api/state actually checks.
 *  Employees keep seeing their real access label client-side (it still rides
 *  along in `S.employees[x].access`) — only token-based authorization is
 *  normalized here. */
const ROLE_BY_ACCESS: Record<string, string> = { admin: 'admin', operator: 'staff', supervisor: 'staff', viewer: 'viewer' };

/**
 * Compatibility session endpoint for the Android TC52 client.
 *
 * Early PDA builds use `/api/auth/pda-session` while the browser uses
 * `/api/auth/login`.  Keeping the credential verification here (rather than
 * redirecting on the client) lets a scanner remain on the warehouse LAN and
 * avoids a misleading 404/"not found" after a successful barcode decode.
 */
authRouter.post(
  '/pda-session',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Do not log credentials.  Keys are sufficient to diagnose a future PDA
    // version mismatch without exposing secrets in the container logs.
    console.info('[pda-session] received fields:', Object.keys(body).sort().join(','));

    const identifier = String(body.username ?? body.userName ?? body.user ?? body.identifier ?? '').trim();
    const password = String(body.password ?? body.passcode ?? body.pin ?? '');
    if (!identifier && !password) {
      /* The TC52 provisioning QR contains the trusted LAN endpoint, not a
         human password.  This is intentionally a *device* identity with the
         legacy `staff` role (warehouse_staff permissions), never an admin
         token.  It keeps scan transactions attributable to the handheld and
         lets the operator authenticate separately by the app's employee/PIN
         workflow when that is enabled. */
      const sourceIp = String(req.ip ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const privateLan = sourceIp === '::1' || sourceIp === '127.0.0.1'
        || /^10\./.test(sourceIp) || /^192\.168\./.test(sourceIp)
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(sourceIp);
      if (!privateLan) throw httpError(403, 'PDA QR session อนุญาตเฉพาะเครือข่ายภายใน', 'pda_lan_only');
      const user = { id: 'pda-qr', username: 'pda-qr-device', name: 'PDA QR Device', role: 'staff' };
      const token = signToken({ sub: user.id, username: user.username, name: user.name, role: user.role });
      return res.json({ ok: true, status: 'connected', token, user, session: { token, user, mode: 'qr' } });
    }
    if (!identifier || !password) {
      throw httpError(400, 'ข้อมูล session ของ PDA ไม่ครบถ้วน', 'invalid_pda_session');
    }

    const db = getDb();
    let [row] = await db.select().from(users).where(eq(users.username, identifier));
    if (!row && identifier.includes('@')) {
      [row] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${identifier})`);
    }
    if (row && (await verifyPassword(password, row.passwordHash))) {
      const token = signToken({ sub: row.id, username: row.username, name: row.name, role: row.role });
      return res.json({ token, user: publicUser(row), session: { token, user: publicUser(row) } });
    }

    let [emp] = await db.select().from(employees).where(eq(employees.username, identifier));
    if (!emp && identifier.includes('@')) {
      [emp] = await db.select().from(employees).where(sql`lower(${employees.data}->>'email') = lower(${identifier})`);
    }
    if (emp?.passwordHash && (await verifyPassword(password, emp.passwordHash))) {
      if (!emp.accountActive) throw httpError(403, 'บัญชีนี้ถูกระงับการใช้งาน', 'account_suspended');
      if (!isWorking(emp.data)) throw httpError(403, 'พนักงานคนนี้ไม่ได้อยู่ในสถานะปฏิบัติงาน', 'employee_not_working');
      const access = (emp.data as Record<string, unknown> | null)?.access;
      const role = ROLE_BY_ACCESS[typeof access === 'string' ? access : 'operator'] ?? 'staff';
      const user = { id: emp.id, username: emp.username, name: emp.name, role, employeeId: emp.id };
      const token = signToken({ sub: emp.id, username: emp.username!, name: emp.name ?? emp.username!, role, employeeId: emp.id, sv: emp.sessionVersion });
      return res.json({ token, user, session: { token, user } });
    }

    throw httpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'invalid_credentials');
  }),
);

authRouter.post('/first-setup', requireAuth, asyncHandler(async (req, res) => {
  const input = firstSetupSchema.parse(req.body);
  const actor = req.user!;
  const db = getDb();
  /* JWT payload accepts a string subject too, but users.id is a numeric serial. */
  const actorId = Number(actor.sub);
  if (!Number.isInteger(actorId)) throw httpError(401, 'เซสชันไม่ถูกต้อง', 'invalid_session');
  const [row] = await db.select().from(users).where(eq(users.id, actorId));
  if (!row || !row.mustChangePassword) throw httpError(409, 'บัญชีนี้ตั้งค่าเริ่มต้นเรียบร้อยแล้ว', 'first_setup_not_required');
  const [existing] = await db.select().from(employees).where(eq(employees.id, input.username.toUpperCase()));
  if (existing && existing.userId !== row.id) throw httpError(409, 'รหัสพนักงานนี้ถูกใช้งานแล้ว', 'employee_taken');
  const passwordHash = await hashPassword(input.password);
  const [updated] = await db.update(users).set({ username: input.username.toUpperCase(), name: input.name, email: input.email, passwordHash, mustChangePassword: false }).where(eq(users.id, row.id)).returning();
  const data = { id: input.username.toUpperCase(), name: input.name, email: input.email, phone: input.phone, role: 'ผู้ดูแลระบบ', access: 'admin', dept: input.department, wh: input.warehouse, status: 'active' };
  if (existing) await db.update(employees).set({ name: input.name, userId: row.id, roleId: 1, data, updatedAt: new Date() }).where(eq(employees.id, existing.id));
  else await db.insert(employees).values({ id: input.username.toUpperCase(), name: input.name, userId: row.id, roleId: 1, data });
  /* The onboarding page promises every step is recorded in the Audit Log. This is
     the step that turns the bootstrap account into a real person's, so it has to
     be there — what changed, never the password itself. */
  await writeAuditLog(db, {
    action: 'credentials_set',
    actor: updated.username,
    itemId: updated.username,
    itemName: input.name,
    before: { username: row.username, name: row.name, email: row.email },
    after: { username: updated.username, name: input.name, email: input.email, department: input.department, warehouse: input.warehouse },
  });
  const token = signToken({ sub: updated.id, username: updated.username, name: updated.name, role: updated.role });
  res.json({ token, user: publicUser(updated) });
}));

/** POST /api/auth/register — create a user account. Admin only. Role is never client-supplied:
 *  every new account starts as 'staff'; an admin promotes via PATCH /users/:id/role. */
authRouter.post(
  '/register',
  requireAuth,
  /* Creating accounts is an administrator's job — this used to be open signup. */
  requirePermission('role.manage'),
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(users).where(eq(users.username, input.username));
    if (existing.length) throw httpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว', 'username_taken');

    const passwordHash = await hashPassword(input.password);
    const [row] = await db
      .insert(users)
      .values({ username: input.username, passwordHash, name: input.name, email: input.email, role: 'staff' })
      .returning();

    const token = signToken({ sub: row.id, username: row.username, name: row.name, role: row.role });
    res.status(201).json({ token, user: publicUser(row) });
  }),
);

/** POST /api/auth/login — exchange credentials for a JWT.
 *
 * Checks the `users` table (system/service accounts — what devices and the
 * seeded admin/admin123 use) first, then falls back to `employees` with a
 * username/password on file (set by an admin via PUT
 * /api/employees/:id/credentials — see routes/pin.ts). Same endpoint, same
 * JWT shape either way; only the employee branch sets `employeeId` on the
 * token so the frontend can tell which one signed in.
 *
 * `username` in the request body is really "identifier" — it also accepts
 * the account's email, since forgetting which username you picked (vs. the
 * one email you always use) is the single most common way people lock
 * themselves out. Tried as username first (the common case, one lookup);
 * email is only a second query when that misses. */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const identifier = input.username.trim();
    const db = getDb();
    let [row] = await db.select().from(users).where(eq(users.username, identifier));
    if (!row && identifier.includes('@')) {
      [row] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${identifier})`);
    }
    if (row && (await verifyPassword(input.password, row.passwordHash))) {
      const token = signToken({ sub: row.id, username: row.username, name: row.name, role: row.role });
      return res.json({ token, user: publicUser(row) });
    }

    let [emp] = await db.select().from(employees).where(eq(employees.username, identifier));
    if (!emp && identifier.includes('@')) {
      [emp] = await db
        .select()
        .from(employees)
        .where(sql`lower(${employees.data}->>'email') = lower(${identifier})`);
    }
    if (emp?.passwordHash && (await verifyPassword(input.password, emp.passwordHash))) {
      if (!emp.accountActive) throw httpError(403, 'บัญชีนี้ถูกระงับการใช้งาน', 'account_suspended');
      if (!isWorking(emp.data)) throw httpError(403, 'พนักงานคนนี้ไม่ได้อยู่ในสถานะปฏิบัติงาน', 'employee_not_working');
      // employees.role is a job TITLE ("หัวหน้างาน") — the actual permission
      // level (operator/supervisor/admin/viewer) only lives in the legacy
      // `data` jsonb blob under `access`, since it never got its own column.
      const access = (emp.data as Record<string, unknown> | null)?.access;
      const accessLevel = typeof access === 'string' && access ? access : 'operator';
      const role = ROLE_BY_ACCESS[accessLevel] ?? 'staff';
      const token = signToken({
        sub: emp.id,
        username: emp.username!,
        name: emp.name ?? emp.username!,
        role,
        employeeId: emp.id,
        sv: emp.sessionVersion,
      });
      return res.json({
        token,
        user: { id: emp.id, username: emp.username, name: emp.name, role, employeeId: emp.id },
      });
    }

    throw httpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'invalid_credentials');
  }),
);

/** GET /api/auth/me — current user from the bearer token. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    /* The permission list rides along here so the SPA can hide menus/buttons
       the account can't use. It is a convenience for the UI only — every route
       re-checks server-side (requirePermission), because a hidden button is
       not a security boundary. */
    const role = await effectivePermissions(req.user);
    /* The JWT cannot carry firstSetupRequired (it changes after the token is
       issued), but the root page and /onboarding both read it from here —
       without it onboarding bounced straight back to "/" and first-time setup
       was never enforced. */
    // Employee tokens carry a text id (e.g. "EMP-002") and have no users row.
    const [account] = req.user!.employeeId
      ? []
      : await getDb().select().from(users).where(eq(users.id, Number(req.user!.sub)));
    res.json({
      user: { ...req.user, firstSetupRequired: !!account?.mustChangePassword },
      role,
      permissions: role.permissions,
      selfEmployeeIds: await selfEmployeeIds(req.user!),
    });
  }),
);

/** GET /api/auth/users — list employee accounts (for the PDA login picker). */
authRouter.get(
  '/users',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = await db.select().from(users);
    res.json({ users: rows.map(publicUser) });
  }),
);

/** PATCH /api/auth/users/:id/role — admin-only: change another account's role.
 *  This is now the single place role is ever assigned. If the account is linked
 *  to a legacy employee record (employees.user_id), that record's `data.access`
 *  is synced in the same transaction so the two role vocabularies never drift
 *  apart again — the JWT-authenticated role is always the source of truth. */
authRouter.patch(
  '/users/:id/role',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, 'รหัสผู้ใช้ไม่ถูกต้อง', 'invalid_id');
    const input = updateRoleSchema.parse(req.body);
    if (isOwnUserAccount(req.user!, id)) throw httpError(403, 'เปลี่ยนสิทธิ์ของบัญชีตัวเองไม่ได้', 'self_role');
    const db = getDb();

    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(users).where(eq(users.id, id));
      if (!before) throw httpError(404, 'ไม่พบผู้ใช้', 'not_found');

      const [updated] = await tx.update(users).set({ role: input.role }).where(eq(users.id, id)).returning();

      const [linkedEmp] = await tx.select().from(employees).where(eq(employees.userId, id));
      if (linkedEmp) {
        const nextAccess = ACCESS_BY_ROLE[input.role] ?? input.role;
        const nextData = { ...(linkedEmp.data as Record<string, unknown>), access: nextAccess };
        await tx.update(employees).set({ data: nextData, updatedAt: new Date() }).where(eq(employees.id, linkedEmp.id));
      }

      await tx.insert(auditLog).values({
        action: 'role_change',
        actor: req.user!.username,
        entityId: String(id),
        entityName: before.name,
        before: { role: before.role },
        after: { role: input.role },
        data: { linkedEmployeeId: linkedEmp?.id ?? null },
      });

      return updated;
    });

    res.json({ user: publicUser(row) });
  }),
);

/** PATCH /api/auth/employees/:empId/link — admin-only: link/unlink a legacy
 *  employee record to a login account, so its access level is driven by
 *  `users.role` from then on instead of being edited independently. */
authRouter.patch(
  '/employees/:empId/link',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { userId } = linkEmployeeSchema.parse(req.body);
    const db = getDb();

    if (userId !== null) {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) throw httpError(404, 'ไม่พบผู้ใช้', 'not_found');
    }

    const [emp] = await db
      .update(employees)
      .set({ userId, updatedAt: new Date() })
      .where(eq(employees.id, req.params.empId))
      .returning();
    if (!emp) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    res.json({ employee: { id: emp.id, name: emp.name, userId: emp.userId } });
  }),
);

function publicUser(row: typeof users.$inferSelect) {
  return { id: row.id, username: row.username, name: row.name, role: row.role, email: row.email, firstSetupRequired: row.mustChangePassword };
}
