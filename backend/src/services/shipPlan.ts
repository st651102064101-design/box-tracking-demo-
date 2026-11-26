/**
 * Which customer an unattended gate ships to. The camera's plate picks a job
 * from the imported list; a truck passing the gate then carries that job.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { shipPlans } from '../db/schema.js';

export type ShipPlan = typeof shipPlans.$inferSelect;

/** A plate and the tags of one truck arrive within this long of each other. */
export const PASSAGE_MS = 30_000;
export const MIN_PLATE_CONFIDENCE = 0.85;

export const normalizePlate = (value: unknown) => String(value ?? '').toUpperCase().replace(/\s+/g, '');
/** yyyy-mm-dd where the warehouses are. */
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

const plates = new Map<number, { plate: string; seenAt: number }>();
const passages = new Map<number, { plate: string; planId: number; seenAt: number }>();
const fresh = <T extends { seenAt: number }>(entry: T | undefined) =>
  entry && Date.now() - entry.seenAt <= PASSAGE_MS ? entry : undefined;

export function notePlate(gate: number, plate: string, confidence: number) {
  if (confidence >= MIN_PLATE_CONFIDENCE) plates.set(gate, { plate: normalizePlate(plate), seenAt: Date.now() });
}
export const plateAt = (gate: number) => fresh(plates.get(gate))?.plate;

const waitingToday = (db: DB) => db.select().from(shipPlans)
  .where(and(eq(shipPlans.status, 'waiting'), eq(shipPlans.planDate, today()))).orderBy(asc(shipPlans.id));

export const anyPlanWaiting = async (db: DB) => (await waitingToday(db)).length > 0;

/** The job for the truck at this gate: the one it is already loading under, else
 *  the oldest waiting one for its plate. */
export async function planAtGate(db: DB, gate: number, plate: string): Promise<ShipPlan | undefined> {
  const passage = fresh(passages.get(gate));
  if (passage && passage.plate === plate) {
    return (await db.select().from(shipPlans).where(eq(shipPlans.id, passage.planId)))[0];
  }
  return (await waitingToday(db)).find((plan) => plan.plate === plate);
}

export async function recordShipment(db: DB, gate: number, plan: ShipPlan, tags: string[]) {
  const current = (await db.select().from(shipPlans).where(eq(shipPlans.id, plan.id)))[0];
  if (!current) return;
  const shippedTags = Array.from(new Set([...current.shippedTags, ...tags])).sort();
  await db.update(shipPlans).set({ status: 'shipped', shippedTags, shippedAt: new Date() }).where(eq(shipPlans.id, plan.id));
  passages.set(gate, { plate: plan.plate, planId: plan.id, seenAt: Date.now() });
}
