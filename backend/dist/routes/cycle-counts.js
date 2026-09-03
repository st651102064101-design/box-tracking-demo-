import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { boxes, cycleCounts, events } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { cycleCountOpenSchema, cycleCountScanSchema } from '../validators/schemas.js';
import { resolveBoxesByCodes } from '../services/rfid.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';
/**
 * ตรวจนับ — cycle counts / stock takes.
 *
 * The PDA's count screen used to be entirely client-side: it compared scans
 * against its own cached box list and wrote nothing back, so a count left no
 * record anyone else could see and two operators counting the same zone had
 * no idea about each other. These endpoints give a count an identity on the
 * server.
 *
 * The shape is deliberately session-based (open → scan* → close) rather than
 * "post the finished result in one call". A count of a real aisle takes
 * minutes and the handheld drops off Wi-Fi constantly mid-shift; scans
 * accumulate server-side as they arrive so a terminal that dies halfway
 * doesn't take the whole count with it, and the session can be resumed from
 * any device standing at that post.
 */
export const cycleCountsRouter = Router();
cycleCountsRouter.use(requireAuth);
/* A stock take adjusts box records, so it rides on box.update; closing one
   out with adjustments applied is a master-data change. */
const canWrite = requirePermission('box.update');
/** Tags currently believed to be sitting in this warehouse/zone. */
async function expectedTags(wh, zone) {
    const db = getDb();
    const rows = await db.select().from(boxes).where(eq(boxes.status, 'warehouse'));
    return rows
        .filter((r) => {
        const loc = (r.location ?? {});
        if (String(loc.wh ?? '') !== wh)
            return false;
        // An empty zone on the session means "whole warehouse", so it matches
        // every box in it — including ones with no zone recorded yet.
        if (zone === '')
            return true;
        return String(loc.zone ?? '') === zone;
    })
        .map((r) => r.tag);
}
const asStrings = (v) => (Array.isArray(v) ? v.map(String) : []);
/** Shape returned to clients — the raw row plus the derived "what's missing". */
function present(row) {
    const expected = asStrings(row.expected);
    const counted = asStrings(row.counted);
    const unexpected = asStrings(row.unexpected);
    const countedSet = new Set(counted);
    const missing = expected.filter((t) => !countedSet.has(t));
    return {
        id: row.id,
        wh: row.wh,
        zone: row.zone,
        status: row.status,
        startedBy: row.startedBy,
        startedAt: row.startedAt,
        closedAt: row.closedAt,
        expected,
        counted,
        unexpected,
        /** Expected here but never scanned — the half that needs chasing down. */
        missing,
        summary: {
            expected: expected.length,
            counted: counted.length,
            missing: missing.length,
            unexpected: unexpected.length,
        },
    };
}
async function loadOr404(id) {
    const [row] = await getDb().select().from(cycleCounts).where(eq(cycleCounts.id, id));
    if (!row)
        throw httpError(404, 'ไม่พบรอบตรวจนับ', 'cycle_count_not_found');
    return row;
}
/** Recent sessions, newest first. `?status=open` narrows to live ones. */
cycleCountsRouter.get('/', asyncHandler(async (req, res) => {
    const db = getDb();
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const conds = [];
    if (typeof req.query.status === 'string')
        conds.push(eq(cycleCounts.status, req.query.status));
    if (typeof req.query.wh === 'string')
        conds.push(eq(cycleCounts.wh, req.query.wh));
    const rows = await db
        .select()
        .from(cycleCounts)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(cycleCounts.startedAt))
        .limit(limit);
    res.json({ count: rows.length, items: rows.map(present) });
}));
cycleCountsRouter.get('/:id', asyncHandler(async (req, res) => {
    res.json(present(await loadOr404(req.params.id)));
}));
/**
 * Opens a session and freezes the expected list. Re-opening the same
 * warehouse/zone while one is still open returns the existing session rather
 * than creating a second: two operators told to count the same aisle should
 * land in the same count, not silently produce two half-counts that each
 * look like they found nothing.
 */
cycleCountsRouter.post('/', canWrite, asyncHandler(async (req, res) => {
    const input = cycleCountOpenSchema.parse(req.body);
    const db = getDb();
    const [open] = await db
        .select()
        .from(cycleCounts)
        .where(and(eq(cycleCounts.wh, input.wh), eq(cycleCounts.zone, input.zone), eq(cycleCounts.status, 'open')));
    if (open)
        return res.status(200).json({ ...present(open), resumed: true });
    const expected = await expectedTags(input.wh, input.zone);
    const id = `CC-${Date.now().toString(36).toUpperCase()}`;
    const [row] = await db
        .insert(cycleCounts)
        .values({
        id,
        wh: input.wh,
        zone: input.zone,
        status: 'open',
        startedBy: req.user.username,
        expected,
        counted: [],
        unexpected: [],
    })
        .returning();
    bump(req.get('X-Client-Id'));
    res.status(201).json({ ...present(row), resumed: false });
}));
/**
 * Records a batch of scans against an open session.
 *
 * Codes are resolved the same way gate.ts and GET /boxes/:code resolve them —
 * barcode, EPC or TID — so the PDA never has to know which kind it just read.
 * Each resolved box is sorted into `counted` (it was expected here) or
 * `unexpected` (it wasn't); codes that match no box at all come back in
 * `unknown` so the operator sees them rather than having them silently
 * swallowed. Re-scanning something already recorded is a no-op, which is what
 * makes a held RFID trigger safe to point at the same shelf twice.
 */
cycleCountsRouter.post('/:id/scan', canWrite, asyncHandler(async (req, res) => {
    const input = cycleCountScanSchema.parse(req.body);
    const db = getDb();
    const row = await loadOr404(req.params.id);
    if (row.status !== 'open') {
        throw httpError(409, 'รอบตรวจนับนี้ปิดแล้ว', 'cycle_count_closed');
    }
    const { resolved, missing: unknown } = await resolveBoxesByCodes(db, input.tags);
    const expected = new Set(asStrings(row.expected));
    const counted = new Set(asStrings(row.counted));
    const unexpected = new Set(asStrings(row.unexpected));
    for (const box of resolved.values()) {
        if (expected.has(box.tag))
            counted.add(box.tag);
        else
            unexpected.add(box.tag);
    }
    const [updated] = await db
        .update(cycleCounts)
        .set({
        counted: Array.from(counted),
        unexpected: Array.from(unexpected),
        updatedAt: new Date(),
    })
        .where(eq(cycleCounts.id, row.id))
        .returning();
    bump(req.get('X-Client-Id'));
    res.json({ ...present(updated), unknown });
}));
/**
 * Closes the session and writes the result where the rest of the system can
 * see it: an `events` row (so it shows up in the dashboard's activity feed
 * alongside gate in/out) and an `audit_log` row (so the discrepancy has a
 * named actor and a before/after, same as any other consequential action).
 *
 * Closing deliberately does NOT touch box statuses. A missing box might be
 * mis-shelved, mid-move, or genuinely lost, and only a person can tell those
 * apart — auto-marking them 'lost' here would turn a counting mistake into a
 * data correction nobody asked for.
 */
cycleCountsRouter.post('/:id/close', canWrite, asyncHandler(async (req, res) => {
    const db = getDb();
    const row = await loadOr404(req.params.id);
    if (row.status === 'closed') {
        throw httpError(409, 'รอบตรวจนับนี้ปิดไปแล้ว', 'cycle_count_closed');
    }
    const closedAt = new Date();
    const [updated] = await db
        .update(cycleCounts)
        .set({ status: 'closed', closedAt, updatedAt: closedAt })
        .where(eq(cycleCounts.id, row.id))
        .returning();
    const result = present(updated);
    await db.insert(events).values({
        data: {
            dir: 'cycle-count',
            id: result.id,
            wh: result.wh,
            zone: result.zone,
            ts: closedAt.toISOString(),
            recorder: req.user.username,
            ...result.summary,
        },
    });
    await writeAuditLog(db, {
        action: 'ตรวจนับ',
        actor: req.user.username,
        itemId: result.id,
        itemName: result.zone ? `${result.wh} · โซน ${result.zone}` : result.wh,
        after: result.summary,
    });
    bump(req.get('X-Client-Id'));
    res.json(result);
}));
/**
 * Marks every still-missing box in a closed count as lost, in one step —
 * the deliberate follow-up to the "closing changes nothing" rule above, for
 * when someone has actually walked the aisle and confirmed the boxes aren't
 * there. Separate endpoint, never automatic.
 */
cycleCountsRouter.post('/:id/mark-missing-lost', requirePermission('master.manage'), asyncHandler(async (req, res) => {
    const db = getDb();
    const row = await loadOr404(req.params.id);
    const result = present(row);
    if (!result.missing.length)
        return res.json({ updated: 0, tags: [] });
    const rows = await db.select().from(boxes).where(inArray(boxes.tag, result.missing));
    const ts = new Date();
    for (const box of rows) {
        const prevHistory = Array.isArray(box.history) ? box.history : [];
        const history = [
            ...prevHistory,
            {
                dir: 'lost',
                ts: ts.toISOString(),
                wh: result.wh,
                note: `ตรวจนับ ${result.id} ไม่พบ`,
                recorder: req.user.username,
            },
        ];
        const data = {
            ...box.data,
            status: 'lost',
            history,
        };
        await db
            .update(boxes)
            .set({ status: 'lost', history, data, updatedAt: ts })
            .where(eq(boxes.tag, box.tag));
        await writeAuditLog(db, {
            action: 'ตีเป็นสูญหาย (ตรวจนับ)',
            actor: req.user.username,
            itemId: box.tag,
            itemName: box.tag,
            before: { status: box.status },
            after: { status: 'lost', cycleCount: result.id },
        });
    }
    bump(req.get('X-Client-Id'));
    res.json({ updated: rows.length, tags: rows.map((r) => r.tag) });
}));
export default cycleCountsRouter;
//# sourceMappingURL=cycle-counts.js.map