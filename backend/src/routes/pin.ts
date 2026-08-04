import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * PDA PIN management — a 4-digit courtesy lock an employee sets on their own
 * badge tap, verified device-side against a bcrypt hash kept here (never the
 * raw digits, never on the device). The employee sets/changes it themselves
 * (already identified by badge — that's what the badge scan just proved).
 */
export const employeePinRouter = Router();
employeePinRouter.use(requireAuth);

const pinSchema = z.object({ pin: z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก') });

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
