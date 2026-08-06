import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { boxTypes, customers, locations } from '../db/schema.js';
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
/* ─── box types ────────────────────────────────────────────────────────────*/
mastersRouter.get('/box-types', asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(boxTypes);
    res.json({ items: rows.map((r) => r.data) });
}));
mastersRouter.post('/box-types', canWrite, asyncHandler(async (req, res) => {
    const input = boxTypeSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(boxTypes).where(eq(boxTypes.id, input.id));
    if (existing.length)
        throw httpError(409, 'มีรหัสประเภทนี้แล้ว', 'duplicate');
    await db.insert(boxTypes).values({
        id: input.id,
        name: input.name,
        unit: input.unit ?? null,
        value: input.value == null ? null : String(input.value),
        dim: input.dim ?? null,
        data: input,
    });
    res.status(201).json(input);
}));
mastersRouter.put('/box-types/:id', canWrite, asyncHandler(async (req, res) => {
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
    if (!updated.length)
        throw httpError(404, 'ไม่พบประเภทกล่อง', 'not_found');
    res.json(input);
}));
mastersRouter.delete('/box-types/:id', canWrite, asyncHandler(async (req, res) => {
    const deleted = await getDb().delete(boxTypes).where(eq(boxTypes.id, req.params.id)).returning();
    if (!deleted.length)
        throw httpError(404, 'ไม่พบประเภทกล่อง', 'not_found');
    res.json({ ok: true });
}));
/* ─── customers ────────────────────────────────────────────────────────────*/
mastersRouter.get('/customers', asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(customers);
    res.json({ items: rows.map((r) => r.data) });
}));
mastersRouter.post('/customers', canWrite, asyncHandler(async (req, res) => {
    const input = customerSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(customers).where(eq(customers.id, input.id));
    if (existing.length)
        throw httpError(409, 'มีรหัสลูกค้านี้แล้ว', 'duplicate');
    await db.insert(customers).values({
        id: input.id,
        name: input.name,
        addr: input.addr ?? null,
        contact: input.contact ?? null,
        returnDays: input.returnDays ?? null,
        data: input,
    });
    res.status(201).json(input);
}));
mastersRouter.put('/customers/:id', canWrite, asyncHandler(async (req, res) => {
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
    if (!updated.length)
        throw httpError(404, 'ไม่พบลูกค้า', 'not_found');
    res.json(input);
}));
mastersRouter.delete('/customers/:id', canWrite, asyncHandler(async (req, res) => {
    const deleted = await getDb().delete(customers).where(eq(customers.id, req.params.id)).returning();
    if (!deleted.length)
        throw httpError(404, 'ไม่พบลูกค้า', 'not_found');
    res.json({ ok: true });
}));
/* ─── locations (Location Master: zone/rack/shelf/slot) ─────────────────────
   Backs the PDA app's cascading location dropdowns — an operator adding a
   zone/rack/shelf/slot that doesn't exist yet writes it here so it becomes
   a real, selectable option everywhere else that reads S.locations, not
   just free text on the one box being put away. */
mastersRouter.get('/locations', asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(locations);
    res.json({ items: rows.map((r) => ({ code: r.code, wh: r.wh, zone: r.zone, rack: r.rack, shelf: r.shelf, slot: r.slot, type: r.type, note: r.note })) });
}));
mastersRouter.post('/locations', canWrite, asyncHandler(async (req, res) => {
    const input = locationSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(locations).where(eq(locations.code, input.code));
    if (existing.length)
        throw httpError(409, 'มีรหัสตำแหน่งนี้แล้ว', 'duplicate');
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
}));
mastersRouter.delete('/locations/:code', canWrite, asyncHandler(async (req, res) => {
    const deleted = await getDb().delete(locations).where(eq(locations.code, req.params.code)).returning();
    if (!deleted.length)
        throw httpError(404, 'ไม่พบตำแหน่ง', 'not_found');
    res.json({ ok: true });
}));
export default mastersRouter;
//# sourceMappingURL=masters.js.map