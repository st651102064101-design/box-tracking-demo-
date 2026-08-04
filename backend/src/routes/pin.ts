import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { emitEvent } from '../lib/bus.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * PDA PIN management — a 4-digit courtesy lock an employee sets on their own
 * badge tap, verified device-side against a bcrypt hash kept here (never the
 * raw digits, never on the device). Two ways in:
 *   - the employee sets/changes it themselves (already identified by badge —
 *     no OTP needed, that's what the badge scan just proved)
 *   - "ลืมรหัส PIN" or an admin-initiated reset from the web app's employee
 *     page — requires a short-lived OTP the admin relays to the employee out
 *     of band (call, chat, whatever's on hand), since this deployment has no
 *     SMS/Line/Teams integration wired up to send it automatically.
 */
export const employeePinRouter = Router();
employeePinRouter.use(requireAuth);

const OTP_TTL_MS = 5 * 60 * 1000;
const pinSchema = z.object({ pin: z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก') });

function genOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

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
      .set({ pinHash, pinResetOtpHash: null, pinResetExpiresAt: null, updatedAt: new Date() })
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

/** Starts a PIN reset: generates a 6-digit OTP good for 5 minutes. Callable
 *  either from the web app's admin-only "รีเซ็ต PIN" button, or straight from
 *  the PDA's own "ลืมรหัส PIN?" (the device's service-account token is
 *  authorized for this too).
 *
 *  Where the code actually goes depends on who asked. The original version
 *  of this route tried to infer that from `req.user.employeeId`, on the
 *  assumption a PDA would be authenticated as the employee themselves — but
 *  every PDA in this deployment signs in with the device's own shared
 *  service account (the same `users` row an admin's own browser session
 *  could also be using), so `employeeId` is never set either way and every
 *  request looked admin-initiated. The OTP was going straight back to the
 *  PDA's own screen — exactly the leak this flow exists to prevent. The PDA
 *  now says so explicitly (`viaDevice: true` in the body) instead of relying
 *  on a token shape that can't actually distinguish the two callers:
 *   - an admin clicking the web button gets it straight back in this
 *     response, same as before.
 *   - a PDA request (`viaDevice: true`) does NOT get it back here — the
 *     whole point of routing a reset through a second person is defeated if
 *     the device that "forgot" its PIN can just read the code off its own
 *     network response. It only goes out via `emitEvent`, which reaches
 *     admin browser tabs over SSE (see the 'pinResetRequested' listener in
 *     legacy.html) — the PDA operator has to get it from an admin who's
 *     actually looking at a screen. */
employeePinRouter.post(
  '/:id/pin/reset',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const otp = genOtp();
    const pinResetOtpHash = await hashPassword(otp);
    const pinResetExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    const updated = await db
      .update(employees)
      .set({ pinResetOtpHash, pinResetExpiresAt, updatedAt: new Date() })
      .where(eq(employees.id, req.params.id))
      .returning({ id: employees.id, name: employees.name });
    if (!updated.length) throw httpError(404, 'ไม่พบพนักงาน', 'not_found');

    const requestedByEmployee = req.body?.viaDevice === true || !!req.user?.employeeId;
    emitEvent('pinResetRequested', {
      employeeId: updated[0].id,
      name: updated[0].name,
      by: req.user?.name ?? null,
      requestedByEmployee,
      // Only carried over SSE when the *device* asked — an admin's own click
      // already gets it in the HTTP response below, so echoing it back over
      // the event too would just pop a redundant modal in their own tab.
      otp: requestedByEmployee ? otp : null,
      ts: new Date().toISOString(),
    });
    res.json({
      otp: requestedByEmployee ? null : otp,
      expiresAt: pinResetExpiresAt.toISOString(),
    });
  }),
);

/** The employee's side of a reset: scan badge on the PDA, enter the OTP the
 *  admin relayed, set a new PIN. */
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
      throw httpError(400, 'ยังไม่มีคำขอรีเซ็ต PIN — ให้ผู้ดูแลระบบกดรีเซ็ตให้ก่อน', 'no_reset_pending');
    }
    if (row.pinResetExpiresAt.getTime() < Date.now()) {
      throw httpError(400, 'รหัส OTP หมดอายุแล้ว — ให้ผู้ดูแลระบบกดรีเซ็ตใหม่', 'otp_expired');
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
