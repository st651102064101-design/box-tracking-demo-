import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { boxes, events, locations } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

/**
 * The PDA's floor-exception buttons — "ของหาย" (a system-directed pick or
 * putaway landed the operator at a location and the box/space wasn't what
 * was expected), "ช่องเก็บเต็ม" (a suggested shelf is already full in
 * person, whatever the system believes), and "อ่านแท็กไม่ติด" (the box is
 * right there but its RFID/barcode won't read). The first two actually
 * change state, not just log a note — see the branches below — because a
 * report an operator can only ever watch land in a feed and never see act
 * on anything trains them to stop bothering to send it:
 *   - "missing": the box is immediately marked lost (same shape as the
 *     dashboard's own markLost()), so it drops out of pick eligibility and
 *     shows up wherever lost boxes already do (loss KPIs, the lost filter,
 *     recoverLost()) without the dashboard needing to know reports exist.
 *   - "bin_full": the matching Location Master row (if one exists — an
 *     ad-hoc scanned location that was never registered has nothing to
 *     flag) gets `reportedFullAt` stamped into its `data`, and
 *     suggest-location excludes it until someone clears the flag from the
 *     dashboard's Location Master table.
 *   - "unreadable_tag": deliberately leaves the box untouched — the box is
 *     right there and fine, only its tag needs replacing, which the PDA
 *     sends the operator straight into RfidRegisterScreen (replace:true) to
 *     do. This endpoint only needs to log the report for the trail.
 *
 * Still written to `events` (the same feed cycle-count closes and gate
 * in/out already land in — see composeState in services/state.ts) so a
 * supervisor sees it land in real time, plus an audit_log entry so it's
 * traceable to who reported it and when. Not box-scoped: `tag` is optional
 * because "this shelf is full" can be reported while standing at a location
 * before the box in hand has been placed anywhere, with nothing yet to look
 * up by tag.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth);
const canWrite = requireRole('admin', 'staff');

const locationShape = z.object({
  wh: z.string().trim().optional().default(''),
  zone: z.string().trim().optional().default(''),
  rack: z.string().trim().optional().default(''),
  shelf: z.string().trim().optional().default(''),
  slot: z.string().trim().optional().default(''),
});

const reportSchema = z.object({
  kind: z.enum(['missing', 'bin_full', 'unreadable_tag']),
  tag: z.string().trim().toUpperCase().optional(),
  location: locationShape.optional(),
  note: z.string().trim().max(500).optional().default(''),
}).refine((v) => Boolean(v.tag) || Boolean(v.location), {
  message: 'ต้องระบุกล่องหรือตำแหน่งอย่างน้อยหนึ่งอย่าง',
}).refine((v) => v.kind !== 'unreadable_tag' || Boolean(v.tag), {
  // Unlike bin_full (which can be reported from a location alone, before any
  // box is in hand), "อ่าน Tag ไม่ติด" is always about a specific box the
  // operator is standing in front of — there's nothing else to flag.
  message: 'ต้องระบุกล่องสำหรับรายงานอ่านแท็กไม่ติด',
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

    // "missing" — mark the box lost right away, in the exact shape the
    // dashboard's own markLost() writes, so every existing lost-box surface
    // (loss KPIs, the lost filter, recoverLost()) picks it up with no
    // frontend changes. Also on the box's own history either way — the same
    // "this is visible from the box's own timeline, not just a global feed"
    // reasoning every other box-scoped write in boxes.ts already follows.
    if (box) {
      const historyEntry =
        input.kind === 'missing'
          ? { dir: 'lost', ts: ts.toISOString(), reason: 'แจ้งของหาย (PDA)', recorder: req.user!.username }
          : eventData;
      const prevHistory = Array.isArray(box.history) ? (box.history as unknown[]) : [];
      const history = [...prevHistory, historyEntry];
      const data: Record<string, unknown> = { ...(box.data as Record<string, unknown>), history };
      if (input.kind === 'missing') {
        data.status = 'lost';
        data.lostAt = ts.toISOString();
        data.lostReason = 'reported-missing';
      }
      await db
        .update(boxes)
        .set({
          history,
          data,
          updatedAt: ts,
          ...(input.kind === 'missing' ? { status: 'lost' } : {}),
        })
        .where(eq(boxes.tag, box.tag));
    }

    // "bin_full" — flag the matching Location Master row so suggest-location
    // stops recommending it. Matched by wh/zone/rack/shelf/slot rather than
    // a code, since the PDA only ever scans a shelf's barcode and reads
    // those fields off it — no code round-trips through the report. A
    // location that was never registered in the master has nothing to flag;
    // the report still lands in `events`/audit_log either way.
    let flaggedLocationCode: string | null = null;
    if (input.kind === 'bin_full' && input.location) {
      const loc = input.location;
      const whLocs = await db.select().from(locations).where(eq(locations.wh, loc.wh));
      const match = whLocs.find(
        (l) =>
          (l.zone ?? '') === loc.zone &&
          (l.rack ?? '') === loc.rack &&
          (l.shelf ?? '') === loc.shelf &&
          (l.slot ?? '') === loc.slot,
      );
      if (match) {
        flaggedLocationCode = match.code;
        const locData = {
          ...(match.data as Record<string, unknown>),
          reportedFullAt: ts.toISOString(),
          reportedFullBy: req.user!.username,
          reportedFullNote: input.note,
        };
        await db.update(locations).set({ data: locData, updatedAt: ts }).where(eq(locations.code, match.code));
      }
    }

    await writeAuditLog(db, {
      action:
        input.kind === 'missing'
          ? 'แจ้งของหาย → ตีสูญหาย'
          : input.kind === 'unreadable_tag'
            ? 'แจ้งอ่านแท็กไม่ติด'
            : 'แจ้งช่องเก็บเต็ม',
      actor: req.user!.username,
      itemId: input.tag ?? flaggedLocationCode ?? 'location',
      itemName: input.tag ?? [input.location?.zone, input.location?.rack, input.location?.shelf, input.location?.slot]
        .filter(Boolean)
        .join('/'),
      before: null,
      after: eventData,
    });

    bump(req.get('X-Client-Id'));
    res.json({ ...eventData, flaggedLocationCode });
  }),
);

export default reportsRouter;
