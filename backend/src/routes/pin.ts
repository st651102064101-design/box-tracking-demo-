import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { employees, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { sendMail } from '../lib/mailer.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import { randomInt } from 'node:crypto';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

/**
 * PDA PIN management — a 4-digit courtesy lock an employee sets on their own
 * badge tap, verified device-side against a bcrypt hash kept here (never the
 * raw digits, never on the device). Two ways in:
 *   - the employee sets/changes it themselves (already identified by badge —
 *     no OTP needed, that's what the badge scan just proved)
 *   - "ลืมรหัส PIN?" mints a short-lived OTP and emails it straight to the
 *     address on the employee's own record — no admin in the loop, since
 *     unlike a shared PDA there's no second person to relay it through.
 */
export const employeePinRouter = Router();
employeePinRouter.use(requireAuth);

const OTP_TTL_MS = 5 * 60 * 1000;
const pinSchema = z.object({ pin: z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก') });

function genOtp(): string {
  return String(randomInt(100000, 1000000)); // 6 digits
}

/* A 4-digit PIN (or a 6-digit OTP) is only worth anything if guessing is
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
 *  reachable from a badge screen nobody has signed into yet, so it needs its
 *  own limit rather than relying on the general auth throttle. */
const pinResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'ขอรหัส OTP บ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
});

/** Set/replace the PIN directly — used right after a badge scan (first-time
 *  setup, or a voluntary change from the in-shift settings screen). No OTP:
 *  the badge scan that got the operator here already proved who they are. */
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

/** Starts a PIN reset: generates a 6-digit OTP good for 5 minutes and emails
 *  it to the address on the employee's own record. Fails with a clear
 *  message (not silently) if there's no email on file yet — an admin needs
 *  to add one via the employee form before this can work for that person. */
employeePinRouter.post(
  '/:id/pin/reset',
  pinResetLimiter,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = await db.select().from(employees).where(eq(employees.id, req.params.id));
    const row = rows[0];
    if (!row) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    const email = ((row.data as Record<string, unknown> | null)?.email as string | undefined)?.trim();
    if (!email) {
      throw httpError(400, 'พนักงานคนนี้ยังไม่มีอีเมลผูกไว้ — ให้ผู้ดูแลระบบเพิ่มอีเมลในหน้าพนักงานก่อน', 'no_email_on_file');
    }

    const otp = genOtp();
    const pinResetOtpHash = await hashPassword(otp);
    const pinResetExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    await db
      .update(employees)
      .set({ pinResetOtpHash, pinResetExpiresAt, updatedAt: new Date() })
      .where(eq(employees.id, req.params.id));

    await sendMail({
      to: email,
      subject: 'รหัส OTP สำหรับตั้ง PIN ใหม่ — BoxTrace',
      text:
        `รหัส OTP ของคุณคือ ${otp}\n\n` +
        `ใช้รหัสนี้ที่หน้า "ลืมรหัส PIN?" บนเครื่อง PDA เพื่อตั้ง PIN ใหม่ — รหัสนี้หมดอายุใน 5 นาที และใช้ได้ครั้งเดียว\n\n` +
        `หากคุณไม่ได้เป็นผู้ขอ ไม่ต้องดำเนินการใดๆ — PIN เดิมของคุณยังใช้งานได้ตามปกติ`,
      html:
        `<p>รหัส OTP ของคุณคือ</p>` +
        `<p style="font:700 32px monospace;letter-spacing:6px;">${otp}</p>` +
        `<p>ใช้รหัสนี้ที่หน้า "ลืมรหัส PIN?" บนเครื่อง PDA เพื่อตั้ง PIN ใหม่ — รหัสนี้หมดอายุใน 5 นาที และใช้ได้ครั้งเดียว</p>` +
        `<p>หากคุณไม่ได้เป็นผู้ขอ ไม่ต้องดำเนินการใดๆ — PIN เดิมของคุณยังใช้งานได้ตามปกติ</p>`,
    });

    res.json({ ok: true, sentTo: maskEmail(email), expiresAt: pinResetExpiresAt.toISOString() });
  }),
);

/** Checks an OTP against what's on file without consuming it or touching the
 *  PIN — lets the client gate the "set a new PIN" screen behind a correct
 *  code instead of only finding out it was wrong after the operator already
 *  typed a new PIN twice. */
const verifyResetSchema = z.object({ otp: z.string().regex(/^\d{6}$/, 'OTP ต้องเป็นตัวเลข 6 หลัก') });
employeePinRouter.post(
  '/:id/pin/reset/verify',
  asyncHandler(async (req, res) => {
    const { otp } = verifyResetSchema.parse(req.body);
    const db = getDb();
    const rows = await db.select().from(employees).where(eq(employees.id, req.params.id));
    const row = rows[0];
    if (!row) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    if (!row.pinResetOtpHash || !row.pinResetExpiresAt) {
      throw httpError(400, 'ยังไม่มีคำขอรีเซ็ต PIN — กด "ลืมรหัส PIN?" เพื่อขอรหัสใหม่ก่อน', 'no_reset_pending');
    }
    if (row.pinResetExpiresAt.getTime() < Date.now()) {
      throw httpError(400, 'รหัส OTP หมดอายุแล้ว — กด "ลืมรหัส PIN?" เพื่อขอรหัสใหม่', 'otp_expired');
    }
    const otpOk = await checkSecret(`otp:${row.id}`, otp, row.pinResetOtpHash);
    if (!otpOk) throw httpError(400, 'รหัส OTP ไม่ถูกต้อง', 'otp_invalid');
    res.json({ ok: true });
  }),
);

/** The employee's side of a reset: enter the OTP that arrived by email,
 *  set a new PIN. */
const confirmResetSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'OTP ต้องเป็นตัวเลข 6 หลัก'),
  pin: z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก'),
});
employeePinRouter.post(
  '/:id/pin/confirm-reset',
  asyncHandler(async (req, res) => {
    const { otp, pin } = confirmResetSchema.parse(req.body);
    const db = getDb();
    const rows = await db.select().from(employees).where(eq(employees.id, req.params.id));
    const row = rows[0];
    if (!row) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    if (!row.pinResetOtpHash || !row.pinResetExpiresAt) {
      throw httpError(400, 'ยังไม่มีคำขอรีเซ็ต PIN — กด "ลืมรหัส PIN?" เพื่อขอรหัสใหม่ก่อน', 'no_reset_pending');
    }
    if (row.pinResetExpiresAt.getTime() < Date.now()) {
      throw httpError(400, 'รหัส OTP หมดอายุแล้ว — กด "ลืมรหัส PIN?" เพื่อขอรหัสใหม่', 'otp_expired');
    }
    const otpOk = await checkSecret(`otp:${row.id}`, otp, row.pinResetOtpHash);
    if (!otpOk) throw httpError(400, 'รหัส OTP ไม่ถูกต้อง', 'otp_invalid');
    const pinHash = await hashPassword(pin);
    await db
      .update(employees)
      .set({ pinHash, pinResetOtpHash: null, pinResetExpiresAt: null, updatedAt: new Date() })
      .where(eq(employees.id, req.params.id));
    misses.delete(`pin:${req.params.id}`); // a proven reset lifts the lock
    await writeAuditLog(db, {
      action: 'pin_reset',
      actor: req.user!.username,
      itemId: req.params.id,
      itemName: row.name ?? req.params.id,
      after: { pinReset: true, via: 'otp' },
    });
    res.json({ ok: true });
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
  if (active === false && req.user!.employeeId === id) {
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
