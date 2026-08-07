import { Router } from 'express';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { boxes, boxTypes, warehouses } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { rfidAssociateSchema } from '../validators/schemas.js';
import { associateTag, detachTag, resolveBoxByCode } from '../services/rfid.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

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
 * Suggests the next box tag, continuing the barcode series that is actually
 * in the DB right now — not one derived from the box type's id, and not one
 * counted off whatever a client's locally-cached box list happens to hold. A
 * second device (or tab) that hasn't refreshed since another one registered a
 * box would otherwise suggest a tag that's already taken.
 *
 * Deriving the prefix from the type id (BT-001 -> "BT001-") was wrong: a real
 * warehouse already runs its own barcode series (BOX-001, BOX-002, ...), and
 * inventing a second parallel series off the type id is not what "count from
 * the latest code in the DB" means to the person looking at the screen.
 *
 * Mirrors legacy.html's tagSeriesFor()/nextTagForType() rule exactly, so the
 * web and the PDA suggest the same tag:
 *   - group tags by their non-numeric prefix, case-insensitively (BOX-010 and
 *     box-010 are one series, not two)
 *   - prefer the series this type already uses; fall back to the whole DB when
 *     the type has no boxes yet
 *   - pick the most-USED series, not the most recent, so a handful of stray
 *     test tags can't drag the whole warehouse onto a new series; ties break
 *     on recency
 *   - the next number counts across every type sharing that prefix (one
 *     barcode series per warehouse), and the zero-padding width comes from the
 *     highest existing tag, so BOX-009 -> BOX-010, never BOX-10
 *
 * Still only a *suggestion* — POST / above rejects a genuine duplicate with
 * 409 regardless of where the tag came from; that's the real guarantee.
 */
boxesRouter.get(
  '/next-tag',
  asyncHandler(async (req, res) => {
    const typeId = typeof req.query.type === 'string' ? req.query.type : '';
    if (!typeId) return res.json({ tag: null });
    const db = getDb();
    const rows = await db.select({ tag: boxes.tag, type: boxes.type, updatedAt: boxes.updatedAt }).from(boxes);

    type Series = {
      variants: Map<string, number>;
      count: number;
      typeCount: number;
      max: number;
      width: number;
      ts: number;
    };
    const all = new Map<string, Series>();
    for (const row of rows) {
      const m = /^(.*\D)(\d+)$/.exec(row.tag ?? '');
      if (!m) continue;
      const pre = m[1]!;
      const digits = m[2]!;
      const key = pre.toLowerCase();
      let e = all.get(key);
      if (!e) {
        e = { variants: new Map(), count: 0, typeCount: 0, max: 0, width: digits.length, ts: 0 };
        all.set(key, e);
      }
      e.variants.set(pre, (e.variants.get(pre) ?? 0) + 1);
      e.count++;
      if (row.type === typeId) e.typeCount++;
      const n = parseInt(digits, 10);
      if (n > e.max) {
        e.max = n;
        e.width = digits.length;
      }
      const ts = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
      if (ts > e.ts) e.ts = ts;
    }

    const list = [...all.values()];
    if (!list.length) {
      // Empty DB — nothing to learn from, so seed a series off the type id.
      const seed = typeId.toUpperCase().replace(/[^A-Z0-9]/g, '') + '-';
      return res.json({ tag: `${seed}1` });
    }
    const scoped = list.filter((e) => e.typeCount > 0);
    const useScoped = scoped.length > 0;
    const pick = (useScoped ? scoped : list).sort((a, b) => {
      const ka = useScoped ? a.typeCount : a.count;
      const kb = useScoped ? b.typeCount : b.count;
      return kb - ka || b.ts - a.ts;
    })[0]!;
    const prefix = [...pick.variants.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    res.json({ tag: `${prefix}${String(pick.max + 1).padStart(pick.width, '0')}` });
  }),
);

const createBoxSchema = z.object({
  tag: z.string().trim().min(1, 'ต้องระบุรหัสกล่อง (บาร์โค้ด)'),
  type: z.string().trim().min(1, 'ต้องระบุประเภทกล่อง'),
  // Both optional and both free text — scanned off a supplier's own lot/
  // expiry barcode where one exists, typed where it doesn't. Round-trip
  // straight through `data` (see composeState in services/state.ts, which
  // returns a box's `data` column verbatim) so the print-label templates
  // that already read b.lot/b.expiry (frontend/public/legacy.html's
  // finLabelHtml/labelToPNG/labelPrintCardHtml) start actually finding
  // something to render instead of always getting undefined.
  lot: z.string().trim().optional(),
  expiry: z.string().trim().optional(),
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
boxesRouter.post(
  '/',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = createBoxSchema.parse(req.body);
    const db = getDb();
    const tag = input.tag.toUpperCase();

    const existing = await db.select({ tag: boxes.tag }).from(boxes).where(eq(boxes.tag, tag));
    if (existing.length) throw httpError(409, `มีกล่องรหัส ${tag} อยู่แล้ว`, 'tag_taken');

    const [bt] = await db.select().from(boxTypes).where(eq(boxTypes.id, input.type));
    if (!bt) throw httpError(400, 'ไม่พบประเภทกล่องนี้ในระบบ', 'unknown_box_type');
    const value = bt.value == null ? null : Number(bt.value);

    const now = new Date();
    const ts = now.toISOString();
    /* A freshly-registered box has physically arrived (or is being data-entered
     * as it arrives) but has no barcode sticker yet, so it can't be scanned
     * through a real Gate/putaway flow — leaving location entirely blank read
     * as "not in the building at all" (loc-none) to anyone looking at the
     * table, which is a real data-integrity problem: the box is sitting at
     * the receiving dock, taking up floor space and countable as on-hand
     * stock, but the system couldn't say where. Auto-assign the default
     * receiving/staging spot instead — mirrors legacy.html's own
     * pendingStageLocation(). Only guessed when there's exactly one
     * warehouse on file; with several, which one this box physically landed
     * at can't be inferred, so it's left unset (still flagged staging via
     * zone/rack, just without a wh) rather than guessed wrong. */
    const whList = await db.select({ id: warehouses.id }).from(warehouses);
    const wh = whList.length === 1 ? whList[0]!.id : '';
    const location = { wh, zone: 'พื้นที่รับของขาเข้า', rack: 'STG-01', shelf: '', slot: '', gate: null, ts };
    const history = [{ dir: 'reg', ts, recorder: req.user!.username }];
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
      ...(input.lot ? { lot: input.lot } : {}),
      ...(input.expiry ? { expiry: input.expiry } : {}),
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
      actor: req.user!.username,
      itemId: tag,
      itemName: bt.name ?? tag,
      before: null,
      after: data,
    });
    bump(req.get('X-Client-Id'));
    res.json(data);
  }),
);

/**
 * Confirms the physical barcode sticker is actually on the box — a
 * distinct step from creating the row (which can happen before the label's
 * printed) and from Putaway (which can't happen before this: an unlabeled
 * box has no barcode a gate scan could ever resolve again). Mirrors
 * legacy.html's "ยืนยันติดป้ายเสร็จแล้ว" button.
 */
boxesRouter.post(
  '/:tag/label',
  canWrite,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [box] = await db.select().from(boxes).where(eq(boxes.tag, req.params.tag));
    if (!box) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    if (box.labeled) throw httpError(409, `กล่อง ${box.tag} ติดป้ายไปแล้ว`, 'already_labeled');

    const ts = new Date().toISOString();
    const prevHistory = Array.isArray(box.history) ? (box.history as unknown[]) : [];
    const history = [...prevHistory, { dir: 'label', ts, recorder: req.user!.username }];
    const data = {
      ...(box.data as Record<string, unknown>),
      labeled: true,
      labeledAt: ts,
      labeledBy: req.user!.username,
      history,
    };
    await db
      .update(boxes)
      .set({ labeled: true, history, data, updatedAt: new Date() })
      .where(eq(boxes.tag, req.params.tag));
    bump(req.get('X-Client-Id'));
    res.json(data);
  }),
);

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
boxesRouter.post(
  '/:tag/putaway',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = putawaySchema.parse(req.body);
    const db = getDb();
    const [box] = await db.select().from(boxes).where(eq(boxes.tag, req.params.tag));
    if (!box) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    if (!box.labeled) throw httpError(409, `กล่อง ${box.tag} ต้องติดป้ายบาร์โค้ดก่อน Putaway`, 'not_labeled');
    if (box.status === 'out') throw httpError(409, `กล่อง ${box.tag} ออกอยู่กับลูกค้า ย้ายตำแหน่งไม่ได้`, 'box_out');
    // Hold/Damage boxes don't get a normal shelf position — Gate In already
    // parks them in quarantine (see gateIn in services/gate.ts). Moving them
    // here instead would silently promote a flagged box back to 'warehouse'
    // and make it look like ordinary shippable stock again.
    if (box.status === 'hold' || box.status === 'damage')
      throw httpError(
        409,
        `กล่อง ${box.tag} ถูกพักไว้ (${box.status === 'hold' ? 'Hold' : 'ชำรุด'}) — ปลดสถานะก่อนจึง Putaway ขึ้นชั้นวางปกติได้`,
        'box_on_hold',
      );

    const wasPending = box.status === 'pending';
    const ts = new Date().toISOString();
    const location = { wh: input.wh, zone: input.zone, rack: input.rack, shelf: input.shelf, slot: input.slot, gate: null, ts };
    const prevHistory = Array.isArray(box.history) ? (box.history as unknown[]) : [];
    const history = [
      ...prevHistory,
      { dir: wasPending ? 'putaway' : 'relocate', ts, wh: input.wh, loc: location, recorder: req.user!.username },
    ];
    const data = {
      ...(box.data as Record<string, unknown>),
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
    /* A PDA tag bind never goes through PUT /api/state, so the dashboard's
       SSE stream (see gate.ts for the same reasoning) has to be told here
       too — otherwise the web only picks it up on its next manual refresh. */
    bump(req.get('X-Client-Id'));
    res.json(result);
  }),
);

/** Detaches whatever RFID tag a box currently carries. */
boxesRouter.delete(
  '/:tag/rfid',
  canWrite,
  asyncHandler(async (req, res) => {
    const result = await detachTag(getDb(), req.params.tag, req.user!.username);
    bump(req.get('X-Client-Id'));
    res.json(result);
  }),
);

export default boxesRouter;
