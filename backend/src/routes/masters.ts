import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { boxTypes, customers, locations, warehouses, employees } from '../db/schema.js';
import { boxTypeSchema, customerSchema, locationSchema } from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

/**
 * Representative master-data CRUD (box types + customers). These demonstrate the
 * granular REST pattern to extend for the remaining masters (warehouses,
 * locations, employees, …) — the state bridge already persists them all.
 */
export const mastersRouter = Router();
mastersRouter.use(requireAuth);
/** 'viewer' may only GET; writes require 'admin' or 'staff'. */
const canWrite = requireRole('admin', 'staff');

/**
 * Suggests the next sequential id for a master-data table, counted from
 * whatever the highest existing id in the DB actually is right now — not
 * from whatever a client's own locally-cached copy of the table happens to
 * hold. A client computing "next" from a stale snapshot (its last GET
 * /api/state, possibly seconds or minutes old on a second device) risks
 * suggesting an id another device already claimed in the meantime; asking
 * the DB directly, right before showing the suggestion, is what makes "count
 * from the latest code in the DB" (rather than "in whatever I last saw")
 * actually true. This is a *suggestion* only — the create endpoints below
 * still reject a genuine duplicate id with 409 regardless of where it came
 * from, which is the actual uniqueness guarantee.
 */
function nextSeqIdFrom(ids: Array<string | null>, prefix: string): string {
  let max = 0;
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
  for (const id of ids) {
    const m = id ? re.exec(id) : null;
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return prefix + String(max + 1).padStart(3, '0');
}

mastersRouter.get(
  '/next-id',
  asyncHandler(async (req, res) => {
    const kind = String(req.query.kind ?? '');
    const db = getDb();
    let ids: Array<string | null>;
    let prefix: string;
    switch (kind) {
      case 'boxtype':
        prefix = 'BT-';
        ids = (await db.select({ id: boxTypes.id }).from(boxTypes)).map((r) => r.id);
        break;
      case 'warehouse':
        prefix = 'WH-';
        ids = (await db.select({ id: warehouses.id }).from(warehouses)).map((r) => r.id);
        break;
      case 'customer':
        prefix = 'CUST-';
        ids = (await db.select({ id: customers.id }).from(customers)).map((r) => r.id);
        break;
      case 'employee':
        prefix = 'EMP-';
        ids = (await db.select({ id: employees.id }).from(employees)).map((r) => r.id);
        break;
      default:
        throw httpError(400, 'kind ต้องเป็น boxtype/warehouse/customer/employee', 'invalid_kind');
    }
    res.json({ id: nextSeqIdFrom(ids, prefix) });
  }),
);

/* ─── box types ────────────────────────────────────────────────────────────*/
mastersRouter.get(
  '/box-types',
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(boxTypes);
    res.json({ items: rows.map((r) => r.data) });
  }),
);

mastersRouter.post(
  '/box-types',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = boxTypeSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(boxTypes).where(eq(boxTypes.id, input.id));
    if (existing.length) throw httpError(409, 'มีรหัสประเภทนี้แล้ว', 'duplicate');
    await db.insert(boxTypes).values({
      id: input.id,
      name: input.name,
      unit: input.unit ?? null,
      value: input.value == null ? null : String(input.value),
      dim: input.dim ?? null,
      data: input,
    });
    res.status(201).json(input);
  }),
);

mastersRouter.put(
  '/box-types/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = boxTypeSchema.parse({ ...req.body, id: req.params.id });
    const db = getDb();
    const updated = await db
      .update(boxTypes)
      .set({
        name: input.name,
        unit: input.unit ?? null,
        value: input.value == null ? null : String(input.value),
        dim: input.dim ?? null,
        data: input,
        updatedAt: new Date(),
      })
      .where(eq(boxTypes.id, req.params.id))
      .returning();
    if (!updated.length) throw httpError(404, 'ไม่พบประเภทกล่อง', 'not_found');
    res.json(input);
  }),
);

mastersRouter.delete(
  '/box-types/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const deleted = await getDb().delete(boxTypes).where(eq(boxTypes.id, req.params.id)).returning();
    if (!deleted.length) throw httpError(404, 'ไม่พบประเภทกล่อง', 'not_found');
    res.json({ ok: true });
  }),
);

/* ─── customers ────────────────────────────────────────────────────────────*/
mastersRouter.get(
  '/customers',
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(customers);
    res.json({ items: rows.map((r) => r.data) });
  }),
);

mastersRouter.post(
  '/customers',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = customerSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(customers).where(eq(customers.id, input.id));
    if (existing.length) throw httpError(409, 'มีรหัสลูกค้านี้แล้ว', 'duplicate');
    await db.insert(customers).values({
      id: input.id,
      name: input.name,
      addr: input.addr ?? null,
      contact: input.contact ?? null,
      returnDays: input.returnDays ?? null,
      data: input,
    });
    res.status(201).json(input);
  }),
);

mastersRouter.put(
  '/customers/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = customerSchema.parse({ ...req.body, id: req.params.id });
    const db = getDb();
    const updated = await db
      .update(customers)
      .set({
        name: input.name,
        addr: input.addr ?? null,
        contact: input.contact ?? null,
        returnDays: input.returnDays ?? null,
        data: input,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, req.params.id))
      .returning();
    if (!updated.length) throw httpError(404, 'ไม่พบลูกค้า', 'not_found');
    res.json(input);
  }),
);

mastersRouter.delete(
  '/customers/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const deleted = await getDb().delete(customers).where(eq(customers.id, req.params.id)).returning();
    if (!deleted.length) throw httpError(404, 'ไม่พบลูกค้า', 'not_found');
    res.json({ ok: true });
  }),
);

/* ─── locations (Location Master: zone/rack/shelf/slot) ─────────────────────
   Backs the PDA app's cascading location dropdowns — an operator adding a
   zone/rack/shelf/slot that doesn't exist yet writes it here so it becomes
   a real, selectable option everywhere else that reads S.locations, not
   just free text on the one box being put away. */
mastersRouter.get(
  '/locations',
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(locations);
    res.json({ items: rows.map((r) => ({ code: r.code, wh: r.wh, zone: r.zone, rack: r.rack, shelf: r.shelf, slot: r.slot, type: r.type, note: r.note })) });
  }),
);

mastersRouter.post(
  '/locations',
  canWrite,
  asyncHandler(async (req, res) => {
    const input = locationSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(locations).where(eq(locations.code, input.code));
    if (existing.length) throw httpError(409, 'มีรหัสตำแหน่งนี้แล้ว', 'duplicate');
    await db.insert(locations).values({
      code: input.code,
      wh: input.wh ?? null,
      zone: input.zone ?? null,
      rack: input.rack ?? null,
      shelf: input.shelf ?? null,
      slot: input.slot ?? null,
      type: input.type ?? null,
      note: input.note ?? null,
      data: input,
    });
    res.status(201).json(input);
  }),
);

mastersRouter.delete(
  '/locations/:code',
  canWrite,
  asyncHandler(async (req, res) => {
    const deleted = await getDb().delete(locations).where(eq(locations.code, req.params.code)).returning();
    if (!deleted.length) throw httpError(404, 'ไม่พบตำแหน่ง', 'not_found');
    res.json({ ok: true });
  }),
);

export default mastersRouter;
