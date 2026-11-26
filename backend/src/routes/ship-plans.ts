/** The imported outbound list (plate → customer / DO). */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { customers, shipPlans } from '../db/schema.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { normalizePlate, today } from '../services/shipPlan.js';
import { bump } from '../lib/bus.js';

export const shipPlansRouter = Router();
shipPlansRouter.use(requireAuth);

const text = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).optional();
const bodySchema = z.object({
  rows: z.array(z.object({ plate: text, customer: text, doNo: text, po: text, date: text })).max(2000),
});

/** Accepts yyyy-mm-dd or dd/mm/yyyy; returns yyyy-mm-dd, or null when it is no date. */
function isoDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const thai = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const parts = iso ? [+iso[1], +iso[2], +iso[3]] : thai ? [+thai[3], +thai[2], +thai[1]] : null;
  if (!parts) return null;
  const [y, m, d] = parts;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
}

shipPlansRouter.get('/', asyncHandler(async (_req, res) => {
  const plans = await getDb().select().from(shipPlans).orderBy(desc(shipPlans.id)).limit(500);
  res.json({ plans, today: today() });
}));

shipPlansRouter.post('/', requirePermission('gate.out'), asyncHandler(async (req, res) => {
  const { rows } = bodySchema.parse(req.body);
  const db = getDb();
  const known = await db.select().from(customers).where(isNull(customers.deletedAt));
  const errors: { row: number; message: string }[] = [];
  const good: (typeof shipPlans.$inferInsert)[] = [];
  rows.forEach((row, index) => {
    const plate = normalizePlate(row.plate);
    const wanted = (row.customer ?? '').toLowerCase();
    const customer = known.find((c) => c.id.toLowerCase() === wanted)
      ?? known.find((c) => String(c.name ?? '').trim().toLowerCase() === wanted);
    const planDate = row.date ? isoDate(row.date) : today();
    const message = !plate ? 'ไม่มีทะเบียนรถ'
      : !wanted || !customer ? `ไม่พบลูกค้า "${row.customer ?? ''}"`
        : !planDate ? `วันที่ไม่ถูกต้อง "${row.date}"` : '';
    if (message) errors.push({ row: index + 1, message });
    else good.push({ plate, customer: customer!.id, doNo: row.doNo || null, po: row.po || null, planDate: planDate!, createdBy: req.user?.name });
  });
  if (good.length) await db.insert(shipPlans).values(good);
  bump();
  res.json({ ok: true, added: good.length, errors });
}));

shipPlansRouter.delete('/:id', requirePermission('gate.out'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, 'รหัสรายการไม่ถูกต้อง', 'invalid_id');
  const gone = await getDb().delete(shipPlans).where(and(eq(shipPlans.id, id), eq(shipPlans.status, 'waiting'))).returning();
  if (!gone.length) throw httpError(404, 'ไม่พบรายการที่ยังรอรถ', 'plan_not_found');
  bump();
  res.json({ ok: true });
}));
