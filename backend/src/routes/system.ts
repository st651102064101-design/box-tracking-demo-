import { Router } from 'express';
import { getDb } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import { SUPER_ADMIN_KEY } from '../lib/permissions.js';
import { wipeSystem } from '../services/systemWipe.js';
import { writeAuditLog } from '../services/audit.js';

export const systemRouter = Router();

/**
 * POST /api/system/wipe — deletes all operational data (boxes, gate/scan
 * history, customers, master data, transactions, logs, …) and every employee
 * except active Super Admin holders, whose profile is reset in place.
 *
 * Same gate as PUT /api/branding: checked against the caller's *role*
 * (`effective.key === SUPER_ADMIN_KEY`), not a permission string — this is
 * deliberately not something any permission grant can hand out, only the
 * role itself. The frontend hides the button for anyone else, but that is a
 * courtesy; this check is what actually stops a direct API call.
 */
systemRouter.post(
  '/wipe',
  requireAuth,
  asyncHandler(async (req, res) => {
    const effective = await effectivePermissions(req.user);
    if (effective.key !== SUPER_ADMIN_KEY) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'เฉพาะผู้ดูแลระบบสูงสุดเท่านั้นที่ล้างข้อมูลระบบทั้งหมดได้',
      });
    }
    const db = getDb();
    const result = await wipeSystem(db);
    /* Written after the transaction commits — audit_log itself was cleared
       inside it, so this is deliberately the first row of the fresh log. */
    await writeAuditLog(db, {
      action: 'system_wipe',
      actor: req.user!.username,
      itemId: 'system',
      itemName: 'Full System Wipe',
      before: null,
      after: { keptEmployeeIds: result.keptEmployeeIds },
    });
    res.json({ ok: true, keptEmployeeIds: result.keptEmployeeIds });
  }),
);

export default systemRouter;
