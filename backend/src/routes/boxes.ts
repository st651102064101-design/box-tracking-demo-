import { Router } from 'express';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { boxes } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

/** Read-only box queries (real reporting API alongside the state bridge). */
export const boxesRouter = Router();
boxesRouter.use(requireAuth);

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

boxesRouter.get(
  '/:tag',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [row] = await db.select().from(boxes).where(eq(boxes.tag, req.params.tag));
    if (!row) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    res.json(row.data);
  }),
);

export default boxesRouter;
