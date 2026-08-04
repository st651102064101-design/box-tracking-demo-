import { Router } from 'express';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { boxes } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { rfidAssociateSchema } from '../validators/schemas.js';
import { associateTag, detachTag, resolveBoxByCode } from '../services/rfid.js';

/** Read-only box queries (real reporting API alongside the state bridge). */
export const boxesRouter = Router();
boxesRouter.use(requireAuth);
const canWrite = requireRole('admin', 'staff');

boxesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const conds: SQL[] = [];
    if (typeof req.query.status === 'string') conds.push(eq(boxes.status, req.query.status));
    if (typeof req.query.customer === 'string') conds.push(eq(boxes.customer, req.query.customer));
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);

    const rows = await db
      .select()
      .from(boxes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(boxes.updatedAt))
      .limit(limit);

    res.json({ count: rows.length, items: rows.map((r) => r.data) });
  }),
);

/**
 * Accepts whatever the scanner produced — a plain barcode ("BOX-015") or an
 * RFID read (EPC or TID hex) — and resolves it against all three the same
 * way gate.ts does, so a PDA never has to know which kind of code it just
 * scanned before looking a box up.
 */
boxesRouter.get(
  '/:code',
  asyncHandler(async (req, res) => {
    const row = await resolveBoxByCode(getDb(), req.params.code);
    if (!row) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    res.json(row.data);
  }),
);

/**
 * Associate (or, with `replace: true`, re-associate after a damaged tag
 * swap) an RFID tag to a box that's already registered by barcode. See
 * services/rfid.ts for the reused-TID and already-tagged exception rules.
 */
boxesRouter.post(
  '/:tag/rfid',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = rfidAssociateSchema.parse(req.body);
    const result = await associateTag(getDb(), {
      tag: req.params.tag,
      rfidTid: input.rfidTid.toUpperCase(),
      rfidEpc: input.rfidEpc.toUpperCase(),
      replace: input.replace,
      actor: req.user!.username,
    });
    res.json(result);
  }),
);

/** Detaches whatever RFID tag a box currently carries. */
boxesRouter.delete(
  '/:tag/rfid',
  canWrite,
  asyncHandler(async (req, res) => {
    const result = await detachTag(getDb(), req.params.tag, req.user!.username);
    res.json(result);
  }),
);

export default boxesRouter;
