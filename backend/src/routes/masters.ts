import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { boxTypes, customers } from '../db/schema.js';
import { boxTypeSchema, customerSchema } from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Representative master-data CRUD (box types + customers). These demonstrate the
 * granular REST pattern to extend for the remaining masters (warehouses,
 * locations, employees, …) — the state bridge already persists them all.
 */
export const mastersRouter = Router();
mastersRouter.use(requireAuth);

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
  asyncHandler(async (req, res) => {
    const deleted = await getDb().delete(customers).where(eq(customers.id, req.params.id)).returning();
    if (!deleted.length) throw httpError(404, 'ไม่พบลูกค้า', 'not_found');
    res.json({ ok: true });
  }),
);

export default mastersRouter;
