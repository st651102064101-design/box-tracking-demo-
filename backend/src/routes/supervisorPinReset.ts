/* Forgotten PIN on the handheld, approved by a supervisor standing there.
   The employee scans their own card, a supervisor (anyone holding the
   employee.pin.manage permission) scans theirs on the same handheld, and the
   employee sets a new PIN right away. No email, no codes sent anywhere, no one waiting elsewhere. */
import { Router } from 'express';
import { z } from 'zod';
import { eq, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

export const supervisorPinResetRouter = Router();

const schema = z.object({
  employeeCard: z.string().trim().min(1).max(60),
  supervisorCard: z.string().trim().min(1).max(60),
  pin: z.string().regex(/^\d{4}$/, 'PIN ต้องเป็นตัวเลข 4 หลัก'),
});
const DENIED = 'บัตรไม่ถูกต้อง หรือบัตรที่ยืนยันไม่มีสิทธิ์อนุมัติ';

/** The barcode on a card is the scan code if one is set, otherwise the employee id. */
async function findByCard(code: string) {
  const db = getDb();
  const key = code.toUpperCase();
  const [row] = await db
    .select()
    .from(employees)
    .where(or(eq(employees.id, key), sql`upper(${employees.data}->>'scanCode') = ${key}`))
    .limit(1);
  return row ?? null;
}

supervisorPinResetRouter.post(
  '/pin-reset-approved',
  asyncHandler(async (req, res) => {
    const sourceIp = String(req.ip ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const privateLan = sourceIp === '::1' || sourceIp === '127.0.0.1'
      || /^10\./.test(sourceIp) || /^192\.168\./.test(sourceIp)
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(sourceIp);
    if (!privateLan) throw httpError(403, 'ใช้ได้เฉพาะเครือข่ายภายในโรงงาน', 'pda_lan_only');

    const input = schema.parse(req.body);
    const emp = await findByCard(input.employeeCard);
    const sup = await findByCard(input.supervisorCard);
    if (!emp || !sup || emp.id === sup.id || emp.accountActive === false || sup.accountActive === false) {
      throw httpError(400, DENIED, 'reset_denied');
    }
    const { permissions } = await effectivePermissions({
      sub: sup.id,
      employeeId: sup.id,
      username: sup.id,
      name: sup.name ?? sup.id,
      role: sup.role ?? 'staff',
    });
    if (!permissions.includes('employee.pin.manage')) throw httpError(400, DENIED, 'reset_denied');

    const db = getDb();
    await db
      .update(employees)
      .set({ pinHash: await hashPassword(input.pin), updatedAt: new Date() })
      .where(eq(employees.id, emp.id));
    await writeAuditLog(db, {
      action: 'pin_reset_approved',
      actor: sup.id,
      itemId: emp.id,
      itemName: emp.name ?? emp.id,
      after: { approvedBy: sup.id, ip: sourceIp },
    });
    bump();
    res.json({ ok: true });
  }),
);
