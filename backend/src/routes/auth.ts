import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users, employees, auditLog } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { sendMail } from '../lib/mailer.js';
import { signToken } from '../lib/jwt.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import {
  loginSchema,
  registerSchema,
  updateRoleSchema,
  linkEmployeeSchema,
  forgotPasswordRequestSchema,
  resetPasswordSchema,
} from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const authRouter = Router();

const OTP_TTL_MS = 5 * 60 * 1000;

function genOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

/** j***n@company.com — enough to confirm "yes, that's my email" without
 *  printing the whole address back over the wire. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const maskedUser = user.length <= 2 ? user[0] + '****' : user.slice(0, 2) + '****';
  const [dName, dExt] = domain.split('.');
  const maskedDomain = dName ? dName[0] + '****' + (dExt ? '.' + dExt : '') : domain;
  return `${maskedUser}@${maskedDomain}`;
}

/** Throttles reset requests per IP — this endpoint sends an email and is
 *  reachable from the login screen by anyone, signed in or not. */
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'ขอรีเซ็ตรหัสผ่านบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
});

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

/** POST /api/auth/forgot-password — starts a reset: generates a 6-digit OTP
 *  good for 5 minutes and emails it to the address on the account's own
 *  record (never one supplied in the request — that would let anyone probe
 *  or hijack a reset by pointing it at their own inbox). Checks `users`
 *  (system/service accounts) first, then falls back to `employees` (accounts
 *  an admin set up via PUT /api/employees/:id/credentials) — same precedence
 *  as POST /login, since either kind of account can sign in here. `username`
 *  also accepts the account's email (same reasoning as POST /login — someone
 *  who can't remember their username is exactly who needs this). Always
 *  responds the same shape whether or not the account exists, except for the
 *  one case an admin actually needs to act on: an account that exists but has
 *  no email on file yet. */
authRouter.post(
  '/forgot-password',
  forgotPasswordLimiter,
  asyncHandler(async (req, res) => {
    const { username } = forgotPasswordRequestSchema.parse(req.body);
    const identifier = username.trim();
    const db = getDb();

    let [userRow] = await db.select().from(users).where(eq(users.username, identifier));
    if (!userRow && identifier.includes('@')) {
      [userRow] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${identifier})`);
    }
    const account = userRow
      ? { kind: 'user' as const, id: userRow.id, email: userRow.email }
      : await (async () => {
          let [empRow] = await db.select().from(employees).where(eq(employees.username, identifier));
          if (!empRow && identifier.includes('@')) {
            [empRow] = await db
              .select()
              .from(employees)
              .where(sql`lower(${employees.data}->>'email') = lower(${identifier})`);
          }
          if (!empRow) return null;
          const email = ((empRow.data as Record<string, unknown> | null)?.email as string | undefined)?.trim() || null;
          return { kind: 'employee' as const, id: empRow.id, email };
        })();

    // Don't reveal whether the username exists — just claim success either way.
    if (!account) return res.json({ ok: true, sentTo: null });
    if (!account.email) {
      throw httpError(
        400,
        'บัญชีนี้ยังไม่มีอีเมลผูกไว้ — ติดต่อผู้ดูแลระบบเพื่อเพิ่มอีเมลก่อน',
        'no_email_on_file',
      );
    }

    const otp = genOtp();
    const passwordResetOtpHash = await hashPassword(otp);
    const passwordResetExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    if (account.kind === 'user') {
      await db.update(users).set({ passwordResetOtpHash, passwordResetExpiresAt }).where(eq(users.id, account.id));
    } else {
      await db
        .update(employees)
        .set({ passwordResetOtpHash, passwordResetExpiresAt })
        .where(eq(employees.id, account.id));
    }

    await sendMail({
      to: account.email,
      subject: 'รหัส OTP สำหรับตั้งรหัสผ่านใหม่ — BoxTrace',
      text:
        `รหัส OTP ของคุณคือ ${otp}\n\n` +
        `ใช้รหัสนี้ที่หน้า "ลืมรหัสผ่าน?" เพื่อตั้งรหัสผ่านใหม่ — รหัสนี้หมดอายุใน 5 นาที และใช้ได้ครั้งเดียว\n\n` +
        `หากคุณไม่ได้เป็นผู้ขอ ไม่ต้องดำเนินการใดๆ — รหัสผ่านเดิมของคุณยังใช้งานได้ตามปกติ`,
      html:
        `<p>รหัส OTP ของคุณคือ</p>` +
        `<p style="font:700 32px monospace;letter-spacing:6px;">${otp}</p>` +
        `<p>ใช้รหัสนี้ที่หน้า "ลืมรหัสผ่าน?" เพื่อตั้งรหัสผ่านใหม่ — รหัสนี้หมดอายุใน 5 นาที และใช้ได้ครั้งเดียว</p>` +
        `<p>หากคุณไม่ได้เป็นผู้ขอ ไม่ต้องดำเนินการใดๆ — รหัสผ่านเดิมของคุณยังใช้งานได้ตามปกติ</p>`,
    });

    res.json({ ok: true, sentTo: maskEmail(account.email) });
  }),
);

/** POST /api/auth/reset-password — the other half of forgot-password: the OTP
 *  that arrived by email, plus a new password. Signs the account straight in
 *  on success so nobody has to remember to go back to the login form. Same
 *  users-then-employees precedence as forgot-password, so whichever table
 *  actually got the OTP on its row is the one that gets checked. */
authRouter.post(
  '/reset-password',
  forgotPasswordLimiter,
  asyncHandler(async (req, res) => {
    const { username, otp, password } = resetPasswordSchema.parse(req.body);
    const identifier = username.trim();
    const db = getDb();
    const passwordHash = await hashPassword(password);

    let [userRow] = await db.select().from(users).where(eq(users.username, identifier));
    if (!userRow && identifier.includes('@')) {
      [userRow] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${identifier})`);
    }
    if (userRow) {
      if (!userRow.passwordResetOtpHash || !userRow.passwordResetExpiresAt) {
        throw httpError(400, 'ยังไม่มีคำขอรีเซ็ตรหัสผ่าน — กด "ลืมรหัสผ่าน?" เพื่อขอรหัสใหม่ก่อน', 'no_reset_pending');
      }
      if (userRow.passwordResetExpiresAt.getTime() < Date.now()) {
        throw httpError(400, 'รหัส OTP หมดอายุแล้ว — กด "ลืมรหัสผ่าน?" เพื่อขอรหัสใหม่', 'otp_expired');
      }
      if (!(await verifyPassword(otp, userRow.passwordResetOtpHash))) {
        throw httpError(400, 'รหัส OTP ไม่ถูกต้อง', 'otp_invalid');
      }
      const [updated] = await db
        .update(users)
        .set({ passwordHash, passwordResetOtpHash: null, passwordResetExpiresAt: null })
        .where(eq(users.id, userRow.id))
        .returning();
      const token = signToken({ sub: updated.id, username: updated.username, name: updated.name, role: updated.role });
      return res.json({ token, user: publicUser(updated) });
    }

    let [empRow] = await db.select().from(employees).where(eq(employees.username, identifier));
    if (!empRow && identifier.includes('@')) {
      [empRow] = await db
        .select()
        .from(employees)
        .where(sql`lower(${employees.data}->>'email') = lower(${identifier})`);
    }
    if (!empRow) throw httpError(400, 'รหัส OTP ไม่ถูกต้อง', 'otp_invalid');
    if (!empRow.passwordResetOtpHash || !empRow.passwordResetExpiresAt) {
      throw httpError(400, 'ยังไม่มีคำขอรีเซ็ตรหัสผ่าน — กด "ลืมรหัสผ่าน?" เพื่อขอรหัสใหม่ก่อน', 'no_reset_pending');
    }
    if (empRow.passwordResetExpiresAt.getTime() < Date.now()) {
      throw httpError(400, 'รหัส OTP หมดอายุแล้ว — กด "ลืมรหัสผ่าน?" เพื่อขอรหัสใหม่', 'otp_expired');
    }
    if (!(await verifyPassword(otp, empRow.passwordResetOtpHash))) {
      throw httpError(400, 'รหัส OTP ไม่ถูกต้อง', 'otp_invalid');
    }
    const [updatedEmp] = await db
      .update(employees)
      .set({ passwordHash, passwordResetOtpHash: null, passwordResetExpiresAt: null })
      .where(eq(employees.id, empRow.id))
      .returning();
    const access = (updatedEmp.data as Record<string, unknown> | null)?.access;
    const accessLevel = typeof access === 'string' && access ? access : 'operator';
    const role = ROLE_BY_ACCESS[accessLevel] ?? 'staff';
    const token = signToken({
      sub: updatedEmp.id,
      username: updatedEmp.username!,
      name: updatedEmp.name ?? updatedEmp.username!,
      role,
      employeeId: updatedEmp.id,
    });
    res.json({
      token,
      user: { id: updatedEmp.id, username: updatedEmp.username, name: updatedEmp.name, role, employeeId: updatedEmp.id },
    });
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
    res.json({ user: req.user, role, permissions: role.permissions });
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
