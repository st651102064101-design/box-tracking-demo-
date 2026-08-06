import { Router } from 'express';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
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

/**
 * Count-by-status only — backs the filter-tab badges (see legacy.html's
 * `#invStatusSeg`) without pulling every box's full jsonb `data` blob the way
 * GET / does. Kept as its own route (not a query flag on GET /) so the
 * dashboard can poll/refresh badge counts on their own cadence, independent
 * of whatever's driving the main table's load. Relies on boxes_status_idx
 * (see schema.sql) so this stays a fast index-only scan as the table grows.
 *
 * The 'pending' bucket is split the same way legacy.html's own
 * localStatusCounts()/statusPill() split it: status='pending' with
 * labeled=true is really "รอ Putaway" (barcode done, just hasn't been
 * gated in yet), not "รอติดบาร์โค้ด". Grouping by status alone and letting
 * the client's Object.assign(local, byStatus) overwrite the client's
 * already-correct split reintroduced that exact double-count bug — this
 * bucket expression has to match on both ends.
 */
const STATUS_BUCKET = sql<string>`case when ${boxes.status} = 'pending' and ${boxes.labeled} = true then 'pendingPutaway' else ${boxes.status} end`;
boxesRouter.get(
  '/status-summary',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db
      .select({ bucket: STATUS_BUCKET, count: count() })
      .from(boxes)
      .groupBy(STATUS_BUCKET);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.bucket] = Number(r.count);
    res.json({ byStatus });
  }),
);

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
      rfidTid: input.rfidTid?.toUpperCase() ?? null,
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
