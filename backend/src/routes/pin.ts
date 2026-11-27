import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { employees, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import { writeAuditLog } from '../services/audit.js';
import { selfEmployeeIds } from '../services/selfRules.js';
import { bump } from '../lib/bus.js';

/**
 * PDA PIN management — a 4-digit courtesy lock an employee sets on their own
 * badge tap, verified device-side against a bcrypt hash kept here (never the
 * raw digits, never on the device). A forgotten PIN is reset by a PIN
 * administrator.
 */
export const employeePinRouter = Router();
employeePinRouter.use(requireAuth);

const pinSchema = z.object({ pin: z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก') });

/* A 4-digit PIN is only worth anything if guessing is
   bounded: five misses lock that employee's check for 15 minutes. Held in
   memory — a restart clears it, which is acceptable for a single-node lock. */
const MAX_MISSES = 5;
const LOCK_MS = 15 * 60 * 1000;
const misses = new Map<string, { count: number; until: number }>();

function assertNotLocked(key: string) {
  const m = misses.get(key);
  if (!m) return;
  if (m.until <= Date.now()) misses.delete(key);
  else if (m.count >= MAX_MISSES) throw httpError(429, 'ใส่รหัสผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่', 'pin_locked');
}

async function checkSecret(key: string, value: string, hash: string): Promise<boolean> {
  assertNotLocked(key);
  const ok = await verifyPassword(value, hash);
  if (ok) misses.delete(key);
  else misses.set(key, { count: (misses.get(key)?.count ?? 0) + 1, until: Date.now() + LOCK_MS });
  return ok;
}

/** Set/replace the PIN directly — used right after a badge scan (first-time
 *  setup, or a voluntary change from the in-shift settings screen). The badge
 *  scan that got the operator here already proved who they are. */
employeePinRouter.put(
  '/:id/pin',
  asyncHandler(async (req, res) => {
    const { pin, currentPin } = pinSchema.extend({ currentPin: z.string().optional() }).parse(req.body);
    const db = getDb();
    /* Who may write someone's PIN: the employee themself, a PIN administrator,
       or a gate terminal — and a terminal may only *replace* an existing PIN
       when it can prove the old one. */
    const user = req.user!;
    const { permissions } = await effectivePermissions(user);
    const self = Boolean(user.employeeId) && String(user.sub) === req.params.id;
    if (!self && !permissions.includes('employee.pin.manage')) {
      if (!permissions.includes('gate.in') && !permissions.includes('gate.out')) {
        throw httpError(403, 'คุณไม่มีสิทธิ์ตั้ง PIN ให้พนักงานคนนี้', 'forbidden');
      }
      const [target] = await db.select().from(employees).where(eq(employees.id, req.params.id));
      if (target?.pinHash && !(currentPin && await checkSecret(`pin:${target.id}`, currentPin, target.pinHash))) {
        throw httpError(403, 'ต้องใส่รหัส PIN เดิมให้ถูกต้องก่อนตั้งใหม่', 'current_pin_required');
      }
    }
    const pinHash = await hashPassword(pin);
    misses.delete(`pin:${req.params.id}`);
    const updated = await db
      .update(employees)
      .set({ pinHash, updatedAt: new Date() })
      .where(eq(employees.id, req.params.id))
      .returning({ id: employees.id, name: employees.name });
    if (!updated.length) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    await writeAuditLog(db, {
      action: 'pin_set',
      actor: req.user!.username,
      itemId: req.params.id,
      itemName: updated[0].name ?? req.params.id,
      after: { pinChanged: true },
    });
    res.json({ ok: true });
  }),
);

/** Verify a PIN at login time. */
employeePinRouter.post(
  '/:id/pin/verify',
  asyncHandler(async (req, res) => {
    const { pin } = pinSchema.parse(req.body);
    const db = getDb();
    const rows = await db.select().from(employees).where(eq(employees.id, req.params.id));
    const row = rows[0];
    if (!row) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    if (!row.pinHash) return res.json({ ok: true, noPinSet: true }); // never set → nothing to check
    const ok = await checkSecret(`pin:${row.id}`, pin, row.pinHash);
    res.json({ ok });
  }),
);

/** Admin sets/replaces an employee's own web-app login (see auth.ts's
 *  employees fallback in POST /api/auth/login). One account per employee,
 *  separate from the `users` table of system/service accounts — deliberately
 *  no "old password" check here, same reasoning as the PIN set endpoint
 *  above: whoever is at this page already had to authenticate as an admin
 *  employee to see the button that calls this. */
const credentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'ใช้ได้เฉพาะตัวอักษร a-z ตัวเลข และ . _ -'),
  password: z.string().min(6, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร').optional(),
  email: z.string().trim().email('อีเมลไม่ถูกต้อง').or(z.literal('')).optional(),
});
employeePinRouter.put(
  '/:id/credentials',
  /* Setting another person's password is full control of their account, so it
     needs the same authority as handing out roles. */
  requirePermission('role.manage'),
  asyncHandler(async (req, res) => {
    const { username, password, email } = credentialsSchema.parse(req.body);
    const db = getDb();
    const [target] = await db.select().from(employees).where(eq(employees.id, req.params.id));
    if (!target) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    if (!password && !target.passwordHash) throw httpError(400, 'กรุณากำหนดรหัสผ่านสำหรับบัญชีใหม่', 'password_required');
    const [systemAccount] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    if (systemAccount && systemAccount.id !== target.userId) {
      throw httpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว', 'username_taken');
    }

    const dupe = await db.select({ id: employees.id }).from(employees).where(eq(employees.username, username));
    if (dupe.length && dupe[0].id !== req.params.id) {
      throw httpError(409, 'ชื่อผู้ใช้นี้ถูกใช้กับพนักงานคนอื่นแล้ว', 'username_taken');
    }

    const data = { ...(target.data as Record<string, unknown>), ...(email === undefined ? {} : { email }) };
    const updated = await db
      .update(employees)
      .set({
        username, data,
        ...(password ? { passwordHash: await hashPassword(password) } : {}),
        // A new name or password signs every existing device out.
        ...(password || username !== target.username ? { sessionVersion: sql`${employees.sessionVersion} + 1` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(employees.id, req.params.id))
      .returning({ id: employees.id, name: employees.name });
    if (!updated.length) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    await writeAuditLog(db, {
      action: 'credentials_set',
      actor: req.user!.username,
      itemId: req.params.id,
      itemName: updated[0].name ?? req.params.id,
      after: { username },
    });
    bump(req.get('X-Client-Id'));
    res.json({ ok: true, username, account: { username, email: String(data.email ?? ''), active: target.accountActive } });
  }),
);

/** Suspend or re-enable an employee's web login, or sign them out everywhere.
 *  Both end current sessions immediately. */
async function changeAccount(req: Parameters<typeof requireAuth>[0], active: boolean | undefined) {
  const id = String(req.params.id);
  if (active === false && (await selfEmployeeIds(req.user!)).includes(id)) {
    throw httpError(409, 'ระงับบัญชีที่กำลังใช้งานอยู่ไม่ได้', 'cannot_suspend_self');
  }
  const db = getDb();
  const updated = await db
    .update(employees)
    .set({ ...(active === undefined ? {} : { accountActive: active }), sessionVersion: sql`${employees.sessionVersion} + 1`, updatedAt: new Date() })
    .where(eq(employees.id, id))
    .returning({ name: employees.name });
  if (!updated.length) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
  await writeAuditLog(db, {
    action: active === undefined ? 'sessions_revoked' : active ? 'account_enabled' : 'account_suspended',
    actor: req.user!.username, itemId: id, itemName: updated[0].name ?? id,
  });
  bump(req.get('X-Client-Id'));
}

employeePinRouter.patch('/:id/account-status', requirePermission('role.manage'), asyncHandler(async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  await changeAccount(req, active);
  res.json({ ok: true, active });
}));

employeePinRouter.post('/:id/revoke-sessions', requirePermission('role.manage'), asyncHandler(async (req, res) => {
  await changeAccount(req, undefined);
  res.json({ ok: true });
}));

const lastPostSchema = z.object({
  wh: z.string().min(1, 'ต้องระบุคลัง'),
  gate: z.union([z.string(), z.number()]).transform((v) => String(v)),
});

/**
 * PUT /api/employees/:id/last-post — the warehouse/gate this employee most
 * recently confirmed on a report screen, so the badge/post-picker on
 * whichever terminal they use next (this PDA, another PDA, the web app) can
 * default to it instead of asking every single shift. Was PDA-local
 * (Prefs.lastWh/lastGate, keyed to the *device*) — that meant the same
 * person re-picked their post from scratch on every other terminal. Merged
 * into the employee's own `data` JSON (read-modify-write, not a raw jsonb
 * patch) rather than routed through PUT /api/state: that endpoint requires
 * admin/staff and replaces the *entire* snapshot, which is both a role this
 * device may not have and a wildly heavier, race-prone tool for updating
 * two fields on one row.
 */
employeePinRouter.put(
  '/:id/last-post',
  asyncHandler(async (req, res) => {
    const { wh, gate } = lastPostSchema.parse(req.body);
    const db = getDb();
    const rows = await db.select({ data: employees.data }).from(employees).where(eq(employees.id, req.params.id));
    if (!rows.length) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    const data = { ...((rows[0].data as Record<string, unknown>) ?? {}), lastWh: wh, lastGate: gate };
    await db.update(employees).set({ data, updatedAt: new Date() }).where(eq(employees.id, req.params.id));
    bump(req.get('X-Client-Id'));
    res.json({ ok: true, lastWh: wh, lastGate: gate });
  }),
);

export default employeePinRouter;
