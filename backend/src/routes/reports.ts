import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { boxes, events } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

/**
 * The PDA's floor-exception buttons — "ของหาย" (a system-directed pick or
 * putaway landed the operator at a location and the box/space wasn't what
 * was expected) and "ช่องเก็บเต็ม" (a suggested shelf is already full in
 * person, whatever the system believes). Deliberately does nothing but
 * *record* the report: no status change, no location change, same
 * philosophy cycle-counts.ts's own close() comment states outright — only a
 * person walking the aisle can tell "genuinely missing" from "mis-shelved",
 * and this button is that person raising a hand, not a data correction.
 *
 * Written to `events` (the same feed cycle-count closes and gate in/out
 * already land in — see composeState in services/state.ts, which is what
 * puts it on the dashboard's activity feed and the PDA's own state
 * snapshot) so a supervisor sees it land in real time, plus an audit_log
 * entry so it's traceable to who reported it and when. Not box-scoped:
 * `tag` is optional because "this shelf is full" can be reported while
 * standing at a location before the box in hand has been placed anywhere,
 * with nothing yet to look up by tag.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth);
/* POST /api/reports files an exception against a box (ของหาย / ช่องเก็บเต็ม)
   from the handheld — it changes that box's state, so box.update is the
   permission that governs it, not report.view (which is about reading the
   reporting screens). */
const canWrite = requirePermission('box.update');

const locationShape = z.object({
  wh: z.string().trim().optional().default(''),
  zone: z.string().trim().optional().default(''),
  rack: z.string().trim().optional().default(''),
  shelf: z.string().trim().optional().default(''),
  slot: z.string().trim().optional().default(''),
});

const reportSchema = z.object({
  kind: z.enum(['missing', 'bin_full']),
  tag: z.string().trim().toUpperCase().optional(),
  location: locationShape.optional(),
  note: z.string().trim().max(500).optional().default(''),
}).refine((v) => Boolean(v.tag) || Boolean(v.location), {
  message: 'ต้องระบุกล่องหรือตำแหน่งอย่างน้อยหนึ่งอย่าง',
});

reportsRouter.post(
  '/',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = reportSchema.parse(req.body);
    const db = getDb();

    let box: typeof boxes.$inferSelect | undefined;
    if (input.tag) {
      [box] = await db.select().from(boxes).where(eq(boxes.tag, input.tag));
      if (!box) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    }

    const ts = new Date();
    const eventData = {
      dir: input.kind,
      tag: input.tag ?? null,
      location: input.location ?? box?.location ?? null,
      note: input.note,
      ts: ts.toISOString(),
      recorder: req.user!.username,
    };
    await db.insert(events).values({ ts, data: eventData });

    // Also on the box's own history, when there is one — the same "this
    // is visible from the box's own timeline, not just a global feed"
    // reasoning every other box-scoped write in boxes.ts already follows.
    if (box) {
      const prevHistory = Array.isArray(box.history) ? (box.history as unknown[]) : [];
      const history = [...prevHistory, eventData];
      const data = { ...(box.data as Record<string, unknown>), history };
      await db.update(boxes).set({ history, data, updatedAt: ts }).where(eq(boxes.tag, box.tag));
    }

    await writeAuditLog(db, {
      action: input.kind === 'missing' ? 'แจ้งของหาย' : 'แจ้งช่องเก็บเต็ม',
      actor: req.user!.username,
      itemId: input.tag ?? 'location',
      itemName: input.tag ?? [input.location?.zone, input.location?.rack, input.location?.shelf, input.location?.slot]
        .filter(Boolean)
        .join('/'),
      before: null,
      after: eventData,
    });

    bump(req.get('X-Client-Id'));
    res.json(eventData);
  }),
);

export default reportsRouter;
