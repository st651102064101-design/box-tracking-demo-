import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users, employees, auditLog } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { loginSchema, registerSchema, updateRoleSchema, linkEmployeeSchema } from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

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

/** POST /api/auth/register — create a user account. Role is never client-supplied:
 *  every self-registration starts as 'staff'; an admin promotes via PATCH /users/:id/role. */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(users).where(eq(users.username, input.username));
    if (existing.length) throw httpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว', 'username_taken');

    const passwordHash = await hashPassword(input.password);
    const [row] = await db
      .insert(users)
      .values({ username: input.username, passwordHash, name: input.name, role: 'staff' })
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
 * token so the frontend can tell which one signed in. */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const db = getDb();
    const [row] = await db.select().from(users).where(eq(users.username, input.username));
    if (row && (await verifyPassword(input.password, row.passwordHash))) {
      const token = signToken({ sub: row.id, username: row.username, name: row.name, role: row.role });
      return res.json({ token, user: publicUser(row) });
    }

    const [emp] = await db.select().from(employees).where(eq(employees.username, input.username));
    if (emp?.passwordHash && (await verifyPassword(input.password, emp.passwordHash))) {
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
    res.json({ user: req.user });
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
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}
