import { Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { boxTypes, customers } from '../db/schema.js';
import { boxTypeSchema, customerSchema } from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

/**
 * Representative master-data CRUD (box types + customers). These demonstrate the
 * granular REST pattern to extend for the remaining masters (warehouses,
 * locations, employees, …) — the state bridge already persists them all.
 */
export const mastersRouter = Router();
mastersRouter.use(requireAuth);
/** 'viewer' may only GET; writes require 'admin' or 'staff'. */
/* Box types are master data; customers/suppliers are partners — two different
   permissions, so "may add a customer" no longer implies "may re-price the
   entire box catalogue". */
const canManageMaster = requirePermission('master.manage');
const canCreatePartner = requirePermission('partner.create');
const canUpdatePartner = requirePermission('partner.update');
const canDeletePartner = requirePermission('partner.delete');

/* ─── box types ────────────────────────────────────────────────────────────*/
mastersRouter.get(
  '/box-types',
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(boxTypes).where(isNull(boxTypes.deletedAt));
    res.json({ items: rows.map((r) => r.data) });
  }),
);

mastersRouter.post(
  '/box-types',
  canManageMaster,
  asyncHandler(async (req, res) => {
    const input = boxTypeSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(boxTypes).where(eq(boxTypes.id, input.id));
    if (existing.length && !existing[0].deletedAt) {
      throw httpError(409, 'มีรหัสประเภทนี้แล้ว', 'duplicate');
    }
    if (existing.length) {
      /* Same id previously soft-deleted — revive it rather than refusing a code
         an admin has every right to reuse, or silently shadowing the deleted
         row with a second one that shares its primary key. */
      await db
        .update(boxTypes)
        .set({
          name: input.name,
          unit: input.unit ?? null,
          value: input.value == null ? null : String(input.value),
          dim: input.dim ?? null,
          data: input,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(boxTypes.id, input.id));
    } else {
      await db.insert(boxTypes).values({
        id: input.id,
        name: input.name,
        unit: input.unit ?? null,
        value: input.value == null ? null : String(input.value),
        dim: input.dim ?? null,
        data: input,
      });
    }
    res.status(201).json(input);
  }),
);

mastersRouter.put(
  '/box-types/:id',
  canManageMaster,
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
      .where(and(eq(boxTypes.id, req.params.id), isNull(boxTypes.deletedAt)))
      .returning();
    if (!updated.length) throw httpError(404, 'ไม่พบประเภทกล่อง', 'not_found');
    res.json(input);
  }),
);

mastersRouter.delete(
  '/box-types/:id',
  canManageMaster,
  asyncHandler(async (req, res) => {
    /* Soft delete: boxes reference `type` as plain text, not a foreign key, so
       a hard DELETE would leave any box that still carries this type pointing
       at nothing — its type name would just vanish from the screen. Setting
       deleted_at removes it from every list/lookup an operator sees while
       leaving already-registered boxes able to still resolve it if anything
       ever needs to (audit exports, old reports). */
    const db = getDb();
    const [row] = await db.select().from(boxTypes).where(eq(boxTypes.id, req.params.id));
    if (!row || row.deletedAt) throw httpError(404, 'ไม่พบประเภทกล่อง', 'not_found');
    await db.update(boxTypes).set({ deletedAt: new Date() }).where(eq(boxTypes.id, req.params.id));
    res.json({ ok: true });
  }),
);

/* ─── customers ────────────────────────────────────────────────────────────*/
mastersRouter.get(
  '/customers',
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(customers).where(isNull(customers.deletedAt));
    res.json({ items: rows.map((r) => r.data) });
  }),
);

mastersRouter.post(
  '/customers',
  canCreatePartner,
  asyncHandler(async (req, res) => {
    const input = customerSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(customers).where(eq(customers.id, input.id));
    if (existing.length && !existing[0].deletedAt) {
      throw httpError(409, 'มีรหัสลูกค้านี้แล้ว', 'duplicate');
    }
    if (existing.length) {
      /* Same reasoning as box types: revive a soft-deleted row on its own id
         rather than refusing to reuse a code, or shadowing it with a duplicate
         primary key. */
      await db
        .update(customers)
        .set({
          name: input.name,
          addr: input.addr ?? null,
          contact: input.contact ?? null,
          returnDays: input.returnDays ?? null,
          data: input,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, input.id));
    } else {
      await db.insert(customers).values({
        id: input.id,
        name: input.name,
        addr: input.addr ?? null,
        contact: input.contact ?? null,
        returnDays: input.returnDays ?? null,
        data: input,
      });
    }
    res.status(201).json(input);
  }),
);

mastersRouter.put(
  '/customers/:id',
  canUpdatePartner,
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
      .where(and(eq(customers.id, req.params.id), isNull(customers.deletedAt)))
      .returning();
    if (!updated.length) throw httpError(404, 'ไม่พบลูกค้า', 'not_found');
    res.json(input);
  }),
);

mastersRouter.delete(
  '/customers/:id',
  canDeletePartner,
  asyncHandler(async (req, res) => {
    /* Soft delete — see the box-types delete handler above for why: boxes,
       DO records and inventory history all reference a customer by plain id,
       and a hard DELETE would either orphan or (if a real FK existed)
       cascade-destroy that history. */
    const db = getDb();
    const [row] = await db.select().from(customers).where(eq(customers.id, req.params.id));
    if (!row || row.deletedAt) throw httpError(404, 'ไม่พบลูกค้า', 'not_found');
    await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, req.params.id));
    res.json({ ok: true });
  }),
);

export default mastersRouter;
