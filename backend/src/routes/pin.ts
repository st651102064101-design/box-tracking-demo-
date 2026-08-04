import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { sendMail } from '../lib/mailer.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

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
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

/** j***n@company.com — enough to confirm "yes, that's my email" without
 *  printing the whole address back over the wire. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const maskedUser = user.length <= 2 ? user[0] + '*' : user[0] + '*'.repeat(user.length - 2) + user.slice(-1);
  return `${maskedUser}@${domain}`;
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
    const { pin } = pinSchema.parse(req.body);
    const db = getDb();
    const pinHash = await hashPassword(pin);
    const updated = await db
      .update(employees)
      .set({ pinHash, updatedAt: new Date() })
      .where(eq(employees.id, req.params.id))
      .returning({ id: employees.id });
    if (!updated.length) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
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
    const ok = await verifyPassword(pin, row.pinHash);
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
    const otpOk = await verifyPassword(otp, row.pinResetOtpHash);
    if (!otpOk) throw httpError(400, 'รหัส OTP ไม่ถูกต้อง', 'otp_invalid');
    const pinHash = await hashPassword(pin);
    await db
      .update(employees)
      .set({ pinHash, pinResetOtpHash: null, pinResetExpiresAt: null, updatedAt: new Date() })
      .where(eq(employees.id, req.params.id));
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
  password: z.string().min(6, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'),
});
employeePinRouter.put(
  '/:id/credentials',
  asyncHandler(async (req, res) => {
    const { username, password } = credentialsSchema.parse(req.body);
    const db = getDb();

    const dupe = await db.select({ id: employees.id }).from(employees).where(eq(employees.username, username));
    if (dupe.length && dupe[0].id !== req.params.id) {
      throw httpError(409, 'ชื่อผู้ใช้นี้ถูกใช้กับพนักงานคนอื่นแล้ว', 'username_taken');
    }

    const passwordHash = await hashPassword(password);
    const updated = await db
      .update(employees)
      .set({ username, passwordHash, updatedAt: new Date() })
      .where(eq(employees.id, req.params.id))
      .returning({ id: employees.id });
    if (!updated.length) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');
    res.json({ ok: true, username });
  }),
);

export default employeePinRouter;
