import { Router } from 'express';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { boxes, boxTypes, locations } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { rfidAssociateSchema } from '../validators/schemas.js';
import { associateTag, detachTag, resolveBoxByCode } from '../services/rfid.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';
/** Read-only box queries (real reporting API alongside the state bridge). */
export const boxesRouter = Router();
boxesRouter.use(requireAuth);
/* RBAC replaces the old blanket admin/staff check: each write now names the
   permission it actually needs, so a role can be allowed to register boxes
   without also being allowed to delete them. */
const canCreate = requirePermission('box.create');
const canUpdate = requirePermission('box.update');
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
const STATUS_BUCKET = sql `case when ${boxes.status} = 'pending' and ${boxes.labeled} = true then 'pendingPutaway' else ${boxes.status} end`;
boxesRouter.get('/status-summary', asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db
        .select({ bucket: STATUS_BUCKET, count: count() })
        .from(boxes)
        .groupBy(STATUS_BUCKET);
    const byStatus = {};
    for (const r of rows)
        byStatus[r.bucket] = Number(r.count);
    res.json({ byStatus });
}));
/**
 * The PDA's "รับเข้า" (Gate In) three-way shelf choice — "ตามที่ระบบแนะนำ" is
 * this endpoint: the first location on [wh]'s own master list (an admin's
 * defined rack/shelf/slot layout, see the `locations` table) that no
 * 'warehouse' box is currently sitting on. "Empty" here means literally
 * unoccupied, not "has spare capacity" — there's no capacity column on a
 * location, so one box is treated as filling it. Returns `{ suggestion:
 * null }` (200, not 404) when the warehouse has no master locations defined
 * yet, or every one of them already has a box — both are "nothing to
 * suggest", not an error, and the PDA falls back to its other two choices
 * (pick by hand, or leave pending-putaway) either way.
 */
boxesRouter.get('/suggest-location', asyncHandler(async (req, res) => {
    const wh = typeof req.query.wh === 'string' ? req.query.wh.trim() : '';
    if (!wh)
        throw httpError(400, 'ต้องระบุคลัง', 'wh_required');
    const db = getDb();
    const locRows = await db.select().from(locations).where(eq(locations.wh, wh));
    // `reason` distinguishes "nobody ever defined a shelf layout for this
    // warehouse" from "every defined shelf already has a box on it" — both
    // render as the same "nothing to suggest" outcome to the client, but a
    // dev/ops person staring at this response while debugging "the PDA says
    // no shelf found and I can see empty ones" needs to tell them apart, since
    // the fixes are completely different (define locations vs. free up a
    // shelf / the request wasn't reaching this code at all).
    if (!locRows.length)
        return res.json({ suggestion: null, reason: 'no_master_locations' });
    const boxRows = await db.select({ location: boxes.location }).from(boxes).where(eq(boxes.status, 'warehouse'));
    const key = (l) => `${l.wh ?? ''}|${l.zone ?? ''}|${l.rack ?? ''}|${l.shelf ?? ''}|${l.slot ?? ''}`;
    const occupied = new Set(boxRows.map((r) => key((r.location ?? {}))));
    const free = locRows.find((loc) => !occupied.has(key(loc)));
    if (!free)
        return res.json({ suggestion: null, reason: 'all_occupied' });
    res.json({
        suggestion: { zone: free.zone ?? '', rack: free.rack ?? '', shelf: free.shelf ?? '', slot: free.slot ?? '' },
    });
}));
boxesRouter.get('/', asyncHandler(async (req, res) => {
    const db = getDb();
    const conds = [];
    if (typeof req.query.status === 'string')
        conds.push(eq(boxes.status, req.query.status));
    if (typeof req.query.customer === 'string')
        conds.push(eq(boxes.customer, req.query.customer));
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    const rows = await db
        .select()
        .from(boxes)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(boxes.updatedAt))
        .limit(limit);
    res.json({ count: rows.length, items: rows.map((r) => r.data) });
}));
const createBoxSchema = z.object({
    tag: z.string().trim().min(1, 'ต้องระบุรหัสกล่อง (บาร์โค้ด)'),
    type: z.string().trim().min(1, 'ต้องระบุประเภทกล่อง'),
});
/**
 * Registers a brand-new box straight off a supplier delivery — the PDA
 * counterpart to legacy.html's "ลงทะเบียนกล่อง" tab (single-box path; the
 * web's own bulk-prefix generator is a desktop-only workflow this doesn't
 * try to replicate). Starts the same lifecycle legacy.html's own
 * `$('#btnAddBox').onclick` does: status 'pending', labeled false, an empty
 * location, and a `history: [{dir:'reg', ...}]` entry — a box is only really
 * "in the warehouse" after label + putaway (see the two routes below).
 *
 * `data` is built to the exact shape legacy.html's own `S.boxes[tag]`
 * object has, not just the typed columns, because GET /api/state only ever
 * surfaces `data` to the frontend (see composeState in services/state.ts) —
 * a box created here with the typed columns right but `data` wrong would
 * look correct in this API's own responses and simply not exist on the web
 * dashboard.
 */
boxesRouter.post('/', canCreate, asyncHandler(async (req, res) => {
    const input = createBoxSchema.parse(req.body);
    const db = getDb();
    const tag = input.tag.toUpperCase();
    const existing = await db.select({ tag: boxes.tag }).from(boxes).where(eq(boxes.tag, tag));
    if (existing.length)
        throw httpError(409, `มีกล่องรหัส ${tag} อยู่แล้ว`, 'tag_taken');
    const [bt] = await db.select().from(boxTypes).where(eq(boxTypes.id, input.type));
    if (!bt)
        throw httpError(400, 'ไม่พบประเภทกล่องนี้ในระบบ', 'unknown_box_type');
    const value = bt.value == null ? null : Number(bt.value);
    const now = new Date();
    const ts = now.toISOString();
    const location = { wh: '', zone: '', rack: '', shelf: '', slot: '', gate: null, ts };
    const history = [{ dir: 'reg', ts, recorder: req.user.username }];
    const data = {
        tag,
        type: input.type,
        value,
        status: 'pending',
        cycles: 0,
        customer: '',
        do: '',
        po: '',
        outGate: null,
        outWh: '',
        outAt: null,
        dueAt: null,
        location,
        lastSeenAt: ts,
        labeled: false,
        history,
    };
    await db.insert(boxes).values({
        tag,
        type: input.type,
        value: value == null ? null : String(value),
        status: 'pending',
        cycles: 0,
        labeled: false,
        location,
        history,
        data,
        updatedAt: now,
    });
    await writeAuditLog(db, {
        action: 'CREATE',
        actor: req.user.username,
        itemId: tag,
        itemName: bt.name ?? tag,
        before: null,
        after: data,
    });
    bump(req.get('X-Client-Id'));
    res.json(data);
}));
/**
 * Confirms the physical barcode sticker is actually on the box — a
 * distinct step from creating the row (which can happen before the label's
 * printed) and from Putaway (which can't happen before this: an unlabeled
 * box has no barcode a gate scan could ever resolve again). Mirrors
 * legacy.html's "ยืนยันติดป้ายเสร็จแล้ว" button.
 */
boxesRouter.post('/:tag/label', canUpdate, asyncHandler(async (req, res) => {
    const db = getDb();
    const [box] = await db.select().from(boxes).where(eq(boxes.tag, req.params.tag));
    if (!box)
        throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    if (box.labeled)
        throw httpError(409, `กล่อง ${box.tag} ติดป้ายไปแล้ว`, 'already_labeled');
    const ts = new Date().toISOString();
    const prevHistory = Array.isArray(box.history) ? box.history : [];
    const history = [...prevHistory, { dir: 'label', ts, recorder: req.user.username }];
    const data = {
        ...box.data,
        labeled: true,
        labeledAt: ts,
        labeledBy: req.user.username,
        history,
    };
    await db
        .update(boxes)
        .set({ labeled: true, history, data, updatedAt: new Date() })
        .where(eq(boxes.tag, req.params.tag));
    bump(req.get('X-Client-Id'));
    res.json(data);
}));
const putawaySchema = z.object({
    wh: z.string().trim().min(1, 'ต้องระบุคลัง'),
    zone: z.string().trim().optional().default(''),
    rack: z.string().trim().optional().default(''),
    shelf: z.string().trim().optional().default(''),
    slot: z.string().trim().optional().default(''),
});
/**
 * Places a labeled box on an actual shelf position — the last step of
 * receiving from a supplier, and also how a box already in the warehouse
 * gets relocated. Mirrors legacy.html's putaway modal (`wasPendingPutaway`
 * in that file's own handler), including the same distinction it draws: a
 * box moving out of 'pending' for the first time logs `dir:'putaway'`,
 * anything already 'warehouse' being moved again logs `dir:'relocate'`.
 */
boxesRouter.post('/:tag/putaway', canUpdate, asyncHandler(async (req, res) => {
    const input = putawaySchema.parse(req.body);
    const db = getDb();
    const [box] = await db.select().from(boxes).where(eq(boxes.tag, req.params.tag));
    if (!box)
        throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    if (!box.labeled)
        throw httpError(409, `กล่อง ${box.tag} ต้องติดป้ายบาร์โค้ดก่อน Putaway`, 'not_labeled');
    if (box.status === 'out')
        throw httpError(409, `กล่อง ${box.tag} ออกอยู่กับลูกค้า ย้ายตำแหน่งไม่ได้`, 'box_out');
    const wasPending = box.status === 'pending';
    const ts = new Date().toISOString();
    const location = { wh: input.wh, zone: input.zone, rack: input.rack, shelf: input.shelf, slot: input.slot, gate: null, ts };
    const prevHistory = Array.isArray(box.history) ? box.history : [];
    const history = [
        ...prevHistory,
        { dir: wasPending ? 'putaway' : 'relocate', ts, wh: input.wh, loc: location, recorder: req.user.username },
    ];
    const data = {
        ...box.data,
        status: 'warehouse',
        location,
        lastSeenAt: ts,
        history,
    };
    await db
        .update(boxes)
        .set({ status: 'warehouse', location, history, lastSeenAt: new Date(), data, updatedAt: new Date() })
        .where(eq(boxes.tag, req.params.tag));
    bump(req.get('X-Client-Id'));
    res.json(data);
}));
/**
 * Accepts whatever the scanner produced — a plain barcode ("BOX-015") or an
 * RFID read (EPC or TID hex) — and resolves it against all three the same
 * way gate.ts does, so a PDA never has to know which kind of code it just
 * scanned before looking a box up.
 */
boxesRouter.get('/:code', asyncHandler(async (req, res) => {
    const row = await resolveBoxByCode(getDb(), req.params.code);
    if (!row)
        throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    res.json(row.data);
}));
/**
 * Associate (or, with `replace: true`, re-associate after a damaged tag
 * swap) an RFID tag to a box that's already registered by barcode. See
 * services/rfid.ts for the reused-TID and already-tagged exception rules.
 */
boxesRouter.post('/:tag/rfid', canUpdate, asyncHandler(async (req, res) => {
    const input = rfidAssociateSchema.parse(req.body);
    const result = await associateTag(getDb(), {
        tag: req.params.tag,
        rfidTid: input.rfidTid?.toUpperCase() ?? null,
        rfidEpc: input.rfidEpc.toUpperCase(),
        replace: input.replace,
        actor: req.user.username,
    });
    /* A PDA tag bind never goes through PUT /api/state, so the dashboard's
       SSE stream (see gate.ts for the same reasoning) has to be told here
       too — otherwise the web only picks it up on its next manual refresh. */
    bump(req.get('X-Client-Id'));
    res.json(result);
}));
/** Detaches whatever RFID tag a box currently carries. */
boxesRouter.delete('/:tag/rfid', canUpdate, asyncHandler(async (req, res) => {
    const result = await detachTag(getDb(), req.params.tag, req.user.username);
    bump(req.get('X-Client-Id'));
    res.json(result);
}));
const holdSchema = z.object({
    // 'warehouse' is release — the box goes back to being pickable. Kept as
    // one endpoint/one verb rather than a separate /release route, because
    // hold/damage/release are really one PDA screen (a status toggle with a
    // reason), not three different actions.
    status: z.enum(['hold', 'damage', 'warehouse']),
    reason: z.string().trim().max(500).optional().default(''),
});
/**
 * Sets or clears hold/damage on a box that's already in the warehouse —
 * the PDA counterpart to a box found damaged on a shelf, or one that needs
 * pulling from pick eligibility for QC, *after* it already cleared Gate In.
 * Gate In's own condition flags (see ApiClient.gateIn's `conditions`) cover
 * the same statuses at receiving time; this is the only way to reach them
 * any other time.
 *
 * Deliberately narrow about which boxes this applies to: 'out' (already
 * shipped) and 'pending'/'lost' boxes aren't sitting on a shelf for an
 * operator to have found a problem with, so holding them here wouldn't mean
 * anything a person standing in the warehouse could have observed. Only
 * 'warehouse'/'hold'/'damage' — i.e. a box physically on hand — can move
 * between those three.
 */
boxesRouter.post('/:tag/hold', canUpdate, asyncHandler(async (req, res) => {
    const input = holdSchema.parse(req.body);
    const db = getDb();
    const [box] = await db.select().from(boxes).where(eq(boxes.tag, req.params.tag));
    if (!box)
        throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    if (!['warehouse', 'hold', 'damage'].includes(box.status)) {
        throw httpError(409, `กล่อง ${box.tag} สถานะ "${box.status}" ไม่สามารถพัก/แจ้งชำรุดได้ — ต้องอยู่ในคลังเท่านั้น`, 'box_not_in_warehouse');
    }
    if (box.status === input.status) {
        throw httpError(409, `กล่อง ${box.tag} อยู่ในสถานะนี้อยู่แล้ว`, 'status_unchanged');
    }
    const ts = new Date();
    const dir = input.status === 'warehouse' ? 'release' : input.status; // 'hold' | 'damage' | 'release'
    const prevHistory = Array.isArray(box.history) ? box.history : [];
    const history = [
        ...prevHistory,
        { dir, ts: ts.toISOString(), reason: input.reason, recorder: req.user.username },
    ];
    const data = { ...box.data, status: input.status, history };
    await db
        .update(boxes)
        .set({ status: input.status, history, data, updatedAt: ts })
        .where(eq(boxes.tag, req.params.tag));
    await writeAuditLog(db, {
        action: dir === 'release' ? 'ปลดพัก' : dir === 'hold' ? 'พักสินค้า' : 'แจ้งชำรุด',
        actor: req.user.username,
        itemId: box.tag,
        itemName: box.tag,
        before: { status: box.status },
        after: { status: input.status, reason: input.reason },
    });
    bump(req.get('X-Client-Id'));
    res.json(data);
}));
export default boxesRouter;
//# sourceMappingURL=boxes.js.map