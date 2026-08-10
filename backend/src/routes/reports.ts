import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { boxes, events } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

/**
 * The PDA's floor-exception buttons — "ของหาย" (a system-directed pick or
 * putaway landed the operator at a location and the box wasn't there),
 * "อ่านแท็กไม่ติด / ป้ายหาย" (the box is right there but its RFID/barcode
 * won't read), and "กล่องชำรุด" (found damaged). All three are box-scoped
 * and all three actually change state, not just log a note — see the
 * branches below — because a report an operator can only ever watch land in
 * a feed and never see act on anything trains them to stop bothering to
 * send it:
 *   - "missing": the box is marked lost (status 'lost'), so it drops out of
 *     pick eligibility. Reversed by POST /reports/resolve.
 *   - "damaged": box.status becomes 'damage', the same status
 *     HoldReleaseScreen's own "แจ้งชำรุด" button sets — this is just a
 *     second door into the same state, opened from the report flow instead
 *     of the hold/release one. Reversed by POST /reports/resolve, which
 *     puts it back to 'warehouse' exactly like HoldReleaseScreen's release.
 *   - "unreadable_tag": leaves box.status untouched (the box itself is
 *     fine) but stamps `data.tagIssueOpenAt` so the open report can be
 *     found and closed later — the box is right there and fine, only its
 *     tag needs replacing, which the PDA separately sends the operator into
 *     RfidRegisterScreen (replace:true) to do. Reversed by
 *     POST /reports/resolve, which clears the stamp.
 *
 * Still written to `events` (the same feed cycle-count closes and gate
 * in/out already land in — see composeState in services/state.ts) so a
 * supervisor sees it land in real time, plus an audit_log entry so it's
 * traceable to who reported (or resolved) it and when.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth);
const canWrite = requireRole('admin', 'staff');

const reportSchema = z.object({
  kind: z.enum(['missing', 'unreadable_tag', 'damaged']),
  tag: z.string().trim().toUpperCase(),
  note: z.string().trim().max(500).optional().default(''),
});

reportsRouter.post(
  '/',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = reportSchema.parse(req.body);
    const db = getDb();

    const [box] = await db.select().from(boxes).where(eq(boxes.tag, input.tag));
    if (!box) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    if (!['warehouse', 'hold', 'damage'].includes(box.status)) {
      throw httpError(
        409,
        `กล่อง ${box.tag} สถานะ "${box.status}" ไม่สามารถแจ้งปัญหาได้ — ต้องอยู่ในคลังเท่านั้น`,
        'box_not_in_warehouse',
      );
    }
    if (input.kind === 'damaged' && box.status === 'damage') {
      throw httpError(409, `กล่อง ${box.tag} แจ้งชำรุดไว้อยู่แล้ว`, 'status_unchanged');
    }
    const boxData = box.data as Record<string, unknown>;
    if (input.kind === 'unreadable_tag' && boxData.tagIssueOpenAt) {
      throw httpError(409, `กล่อง ${box.tag} แจ้งอ่านแท็กไม่ติดไว้อยู่แล้ว`, 'status_unchanged');
    }

    const ts = new Date();
    const eventData = {
      dir: input.kind,
      tag: box.tag,
      location: box.location,
      note: input.note,
      ts: ts.toISOString(),
      recorder: req.user!.username,
    };
    await db.insert(events).values({ ts, data: eventData });

    // Each kind flips exactly the state its own resolve call flips back —
    // see the class doc comment above for why each one changes state at
    // all, not just logs a note.
    const historyEntry =
      input.kind === 'missing'
        ? { dir: 'lost', ts: ts.toISOString(), reason: 'แจ้งของหาย (PDA)', recorder: req.user!.username }
        : eventData;
    const prevHistory = Array.isArray(box.history) ? (box.history as unknown[]) : [];
    const history = [...prevHistory, historyEntry];
    const data: Record<string, unknown> = { ...boxData, history };
    let status = box.status;
    if (input.kind === 'missing') {
      status = 'lost';
      data.status = 'lost';
      data.lostAt = ts.toISOString();
      data.lostReason = 'reported-missing';
    } else if (input.kind === 'damaged') {
      status = 'damage';
      data.status = 'damage';
    } else {
      data.tagIssueOpenAt = ts.toISOString();
    }
    await db
      .update(boxes)
      .set({ status, history, data, updatedAt: ts })
      .where(eq(boxes.tag, box.tag));

    await writeAuditLog(db, {
      action:
        input.kind === 'missing'
          ? 'แจ้งของหาย → ตีสูญหาย'
          : input.kind === 'unreadable_tag'
            ? 'แจ้งอ่านแท็กไม่ติด'
            : 'แจ้งกล่องชำรุด',
      actor: req.user!.username,
      itemId: box.tag,
      itemName: box.tag,
      before: { status: box.status },
      after: eventData,
    });

    bump(req.get('X-Client-Id'));
    res.json(eventData);
  }),
);

const resolveSchema = z.object({
  kind: z.enum(['missing', 'unreadable_tag', 'damaged']),
  tag: z.string().trim().toUpperCase(),
});

/**
 * The other half of every report above — "เจอของแล้ว" / "อ่านแท็กติดแล้ว /
 * ป้ายไม่หายแล้ว" / "ซ่อมแล้ว". Each just puts back exactly what its report
 * branch changed; a report an operator can never mark closed just keeps
 * looking open forever, which is the same "log with no way to act on it"
 * problem the reports themselves were written to avoid.
 */
reportsRouter.post(
  '/resolve',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = resolveSchema.parse(req.body);
    const db = getDb();
    const [box] = await db.select().from(boxes).where(eq(boxes.tag, input.tag));
    if (!box) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');

    const boxData = box.data as Record<string, unknown>;
    if (input.kind === 'missing' && box.status !== 'lost') {
      throw httpError(409, `กล่อง ${box.tag} ไม่ได้อยู่ในสถานะของหาย`, 'not_open');
    }
    if (input.kind === 'damaged' && box.status !== 'damage') {
      throw httpError(409, `กล่อง ${box.tag} ไม่ได้อยู่ในสถานะแจ้งชำรุด`, 'not_open');
    }
    if (input.kind === 'unreadable_tag' && !boxData.tagIssueOpenAt) {
      throw httpError(409, `กล่อง ${box.tag} ไม่ได้แจ้งอ่านแท็กไม่ติดไว้`, 'not_open');
    }

    const ts = new Date();
    const dir =
      input.kind === 'missing' ? 'found' : input.kind === 'damaged' ? 'repaired' : 'tag_ok';
    const eventData = { dir, tag: box.tag, location: box.location, ts: ts.toISOString(), recorder: req.user!.username };
    await db.insert(events).values({ ts, data: eventData });

    const prevHistory = Array.isArray(box.history) ? (box.history as unknown[]) : [];
    const history = [...prevHistory, eventData];
    const data: Record<string, unknown> = { ...boxData, history };
    let status = box.status;
    if (input.kind === 'missing' || input.kind === 'damaged') {
      status = 'warehouse';
      data.status = 'warehouse';
    } else {
      delete data.tagIssueOpenAt;
    }
    await db
      .update(boxes)
      .set({ status, history, data, updatedAt: ts })
      .where(eq(boxes.tag, box.tag));

    await writeAuditLog(db, {
      action:
        input.kind === 'missing'
          ? 'เจอของแล้ว'
          : input.kind === 'unreadable_tag'
            ? 'อ่านแท็กติดแล้ว / ป้ายไม่หายแล้ว'
            : 'ซ่อมแล้ว',
      actor: req.user!.username,
      itemId: box.tag,
      itemName: box.tag,
      before: { status: box.status },
      after: eventData,
    });

    bump(req.get('X-Client-Id'));
    res.json(eventData);
  }),
);

export default reportsRouter;
