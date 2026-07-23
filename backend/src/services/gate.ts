/**
 * Gate operations as a first-class REST service — the same status transitions
 * the legacy UI performs client-side, but executed server-side so physical RFID
 * readers / integrations can POST scans directly.
 *
 * Box lifecycle (mirrors the original app):
 *   pending → (label) → out → warehouse → out → …   (cycles++ on each return)
 */
import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { boxes, customers, config, gates, events, doRecords } from '../db/schema.js';
import { httpError } from '../middleware/error.js';

const DAY = 86_400_000;
const iso = () => new Date().toISOString();

async function warehouseOfGate(db: DB, gate: number): Promise<string> {
  const [row] = await db.select().from(gates).where(eq(gates.gateNo, gate));
  return row?.warehouseId ?? '';
}

export interface GateOutInput {
  tags: string[];
  customer: string;
  gate: number;
  doNo?: string;
  po?: string;
  recorder?: string;
}

export async function gateOut(db: DB, input: GateOutInput) {
  const { tags, customer, gate } = input;
  const recorder = input.recorder ?? 'api';
  const doNo = input.doNo ?? `DO-${Date.now()}`;
  const po = input.po ?? '';

  const [cust] = await db.select().from(customers).where(eq(customers.id, customer));
  if (!cust) throw httpError(404, 'ไม่พบลูกค้า', 'customer_not_found');
  const [cfg] = await db.select().from(config);
  const rows = await db.select().from(boxes).where(inArray(boxes.tag, tags));
  const found = new Map(rows.map((r) => [r.tag, r]));
  const missing = tags.filter((t) => !found.has(t));
  if (missing.length) throw httpError(404, `ไม่พบกล่อง: ${missing.join(', ')}`, 'box_not_found');

  const wh = await warehouseOfGate(db, gate);
  const returnDays = cust.returnDays ?? cfg?.agingDays ?? 15;
  const outTs = iso();
  const dueTs = new Date(Date.now() + returnDays * DAY).toISOString();
  const shipped: string[] = [];

  await db.transaction(async (tx) => {
    for (const tag of tags) {
      const row = found.get(tag)!;
      const b = { ...(row.data as Record<string, unknown>) };
      b.status = 'out';
      b.customer = customer;
      b.do = doNo;
      b.po = po;
      b.outGate = gate;
      b.outWh = wh;
      b.outAt = outTs;
      b.dueAt = dueTs;
      b.returnDays = returnDays;
      b.lastSeenAt = outTs;
      const history = Array.isArray(b.history) ? (b.history as unknown[]) : [];
      history.push({ dir: 'out', ts: outTs, do: doNo, po, customer, gate, wh, recorder, dueAt: dueTs, returnDays });
      b.history = history;

      await tx
        .update(boxes)
        .set({
          status: 'out',
          customer,
          doNo,
          po,
          outGate: gate,
          outWh: wh,
          outAt: new Date(outTs),
          dueAt: new Date(dueTs),
          lastSeenAt: new Date(outTs),
          data: b,
          updatedAt: new Date(),
        })
        .where(eq(boxes.tag, tag));

      await tx.insert(events).values({
        ts: new Date(outTs),
        data: { ts: outTs, dir: 'out', tag, type: row.type, do: doNo, po, customer, customerName: cust.name, gate, wh, recorder },
      });
      shipped.push(tag);
    }

    await tx
      .insert(doRecords)
      .values({ id: doNo, data: { customer, po, returnDays } })
      .onConflictDoUpdate({ target: doRecords.id, set: { data: { customer, po, returnDays } } });
  });

  return { ok: true, doNo, shipped, dueAt: dueTs, count: shipped.length };
}

export interface GateInInput {
  tags: string[];
  gate: number;
  recorder?: string;
}

export async function gateIn(db: DB, input: GateInInput) {
  const { tags, gate } = input;
  const recorder = input.recorder ?? 'api';
  const wh = await warehouseOfGate(db, gate);
  const inTs = iso();
  const rows = await db.select().from(boxes).where(inArray(boxes.tag, tags));
  const found = new Map(rows.map((r) => [r.tag, r]));
  const received: string[] = [];
  const unknown: string[] = [];

  await db.transaction(async (tx) => {
    for (const tag of tags) {
      const row = found.get(tag);
      if (!row) {
        unknown.push(tag);
        continue;
      }
      const b = { ...(row.data as Record<string, unknown>) };
      const wasOut = b.status === 'out';
      b.status = 'warehouse';
      b.cycles = (Number(b.cycles) || 0) + (wasOut ? 1 : 0);
      b.lastSeenAt = inTs;
      const history = Array.isArray(b.history) ? (b.history as unknown[]) : [];
      history.push({ dir: 'in', ts: inTs, gate, wh, recorder });
      b.history = history;

      await tx
        .update(boxes)
        .set({
          status: 'warehouse',
          cycles: (row.cycles ?? 0) + (wasOut ? 1 : 0),
          lastSeenAt: new Date(inTs),
          data: b,
          updatedAt: new Date(),
        })
        .where(eq(boxes.tag, tag));

      await tx.insert(events).values({
        ts: new Date(inTs),
        data: { ts: inTs, dir: wasOut ? 'in' : 'in-new', tag, type: row.type, do: b.do, customer: b.customer, gate, wh, recorder },
      });
      received.push(tag);
    }
  });

  return { ok: true, received, unknown, count: received.length };
}
