/**
 * The heart of the "keep the frontend 100% identical" bridge.
 *
 * The legacy single-page app owns one big runtime object `S` and used to
 * persist it wholesale to localStorage. Here we translate between that `S`
 * snapshot and the normalized Postgres tables:
 *   - composeState():  DB rows  → S   (used by GET  /api/state)
 *   - replaceState():  S        → DB  (used by PUT  /api/state)
 *
 * Every entity keeps a verbatim `data` JSONB copy, so the round-trip is lossless
 * while the extracted typed columns stay available for real SQL/reporting.
 */
import { asc } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  boxes,
  customers,
  boxTypes,
  warehouses,
  gates,
  locations,
  employees,
  vehicles,
  doRecords,
  putaway,
  inventory,
  events,
  auditLog,
  config,
  sequences,
} from '../db/schema.js';
import type { StatePayload } from '../validators/schemas.js';

/* ─── helpers ──────────────────────────────────────────────────────────────*/
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};
const toNumStr = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);
const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* ─── DB → S ───────────────────────────────────────────────────────────────*/
export async function composeState(db: DB): Promise<Record<string, unknown>> {
  const [
    boxRows,
    custRows,
    btRows,
    whRows,
    gateRows,
    locRows,
    empRows,
    vehRows,
    doRows,
    putRows,
    invRows,
    eventRows,
    auditRows,
    cfgRows,
    seqRows,
  ] = await Promise.all([
    db.select().from(boxes),
    db.select().from(customers),
    db.select().from(boxTypes),
    db.select().from(warehouses),
    db.select().from(gates),
    db.select().from(locations),
    db.select().from(employees),
    db.select().from(vehicles),
    db.select().from(doRecords),
    db.select().from(putaway),
    db.select().from(inventory),
    db.select().from(events).orderBy(asc(events.id)),
    db.select().from(auditLog).orderBy(asc(auditLog.id)),
    db.select().from(config),
    db.select().from(sequences),
  ]);

  const mapBy = <T extends { data: unknown }>(rows: T[], key: (r: T) => string) =>
    Object.fromEntries(rows.map((r) => [key(r), r.data]));

  const cfgRow = cfgRows[0];
  const cfg = cfgRow
    ? { agingDays: cfgRow.agingDays, boxValue: Number(cfgRow.boxValue), lostMode: cfgRow.lostMode }
    : { agingDays: 15, boxValue: 450, lostMode: 'manual' };

  return {
    boxes: mapBy(boxRows, (r) => r.tag),
    customers: mapBy(custRows, (r) => r.id),
    boxtypes: mapBy(btRows, (r) => r.id),
    warehouses: mapBy(whRows, (r) => r.id),
    gates: Object.fromEntries(gateRows.map((r) => [String(r.gateNo), r.warehouseId])),
    events: eventRows.map((r) => r.data),
    cfg,
    seq: Object.fromEntries(seqRows.map((r) => [r.name, r.value])),
    vehicles: mapBy(vehRows, (r) => r.id),
    putaway: mapBy(putRows, (r) => r.id),
    doRecords: mapBy(doRows, (r) => r.id),
    employees: mapBy(empRows, (r) => r.id),
    locations: mapBy(locRows, (r) => r.code),
    inventory: mapBy(invRows, (r) => r.id),
    auditLog: auditRows.map((r) => r.data),
  };
}

/* ─── S → DB (wholesale replace, transactional) ────────────────────────────*/
export async function replaceState(db: DB, s: StatePayload): Promise<void> {
  await db.transaction(async (tx) => {
    // 1) wipe all domain tables (users are untouched)
    await Promise.all([
      tx.delete(boxes),
      tx.delete(customers),
      tx.delete(boxTypes),
      tx.delete(warehouses),
      tx.delete(gates),
      tx.delete(locations),
      tx.delete(employees),
      tx.delete(vehicles),
      tx.delete(doRecords),
      tx.delete(putaway),
      tx.delete(inventory),
      tx.delete(events),
      tx.delete(auditLog),
      tx.delete(sequences),
    ]);

    // 2) config singleton (upsert id=1)
    const cfg = s.cfg ?? {};
    await tx
      .insert(config)
      .values({
        id: 1,
        agingDays: toInt(cfg.agingDays) ?? 15,
        boxValue: toNumStr(cfg.boxValue) ?? '450',
        lostMode: (cfg.lostMode as string) ?? 'manual',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: config.id,
        set: {
          agingDays: toInt(cfg.agingDays) ?? 15,
          boxValue: toNumStr(cfg.boxValue) ?? '450',
          lostMode: (cfg.lostMode as string) ?? 'manual',
          updatedAt: new Date(),
        },
      });

    // 3) sequences
    const seqRows = Object.entries(s.seq ?? {}).map(([name, value]) => ({
      name,
      value: toInt(value) ?? 0,
    }));
    if (seqRows.length) await tx.insert(sequences).values(seqRows);

    // 4) boxes
    const boxRows = Object.entries(s.boxes ?? {}).map(([tag, raw]) => {
      const b = raw as Record<string, unknown>;
      return {
        tag,
        type: (b.type as string) ?? null,
        value: toNumStr(b.value),
        status: (b.status as string) ?? 'pending',
        cycles: toInt(b.cycles) ?? 0,
        customer: (b.customer as string) ?? null,
        doNo: (b.do as string) ?? null,
        po: (b.po as string) ?? null,
        outGate: toInt(b.outGate),
        outWh: (b.outWh as string) ?? null,
        outAt: toDate(b.outAt),
        dueAt: toDate(b.dueAt),
        lastSeenAt: toDate(b.lastSeenAt),
        labeled: b.labeled !== false,
        location: (b.location as object) ?? {},
        history: (b.history as unknown[]) ?? [],
        data: b,
        updatedAt: new Date(),
      };
    });
    await chunkInsert(tx, boxes, boxRows);

    // 5) master data
    await chunkInsert(
      tx,
      customers,
      Object.entries(s.customers ?? {}).map(([id, raw]) => {
        const c = raw as Record<string, unknown>;
        return {
          id,
          name: (c.name as string) ?? null,
          addr: (c.addr as string) ?? null,
          contact: (c.contact as string) ?? null,
          returnDays: toInt(c.returnDays),
          data: c,
          updatedAt: new Date(),
        };
      }),
    );

    await chunkInsert(
      tx,
      boxTypes,
      Object.entries(s.boxtypes ?? {}).map(([id, raw]) => {
        const t = raw as Record<string, unknown>;
        return {
          id,
          name: (t.name as string) ?? null,
          unit: (t.unit as string) ?? null,
          value: toNumStr(t.value),
          dim: (t.dim as string) ?? null,
          data: t,
          updatedAt: new Date(),
        };
      }),
    );

    await chunkInsert(
      tx,
      warehouses,
      Object.entries(s.warehouses ?? {}).map(([id, raw]) => {
        const w = raw as Record<string, unknown>;
        return {
          id,
          name: (w.name as string) ?? null,
          gateType: (w.gateType as string) ?? null,
          gates: (w.gates as unknown[]) ?? [],
          gateTypes: (w.gateTypes as object) ?? {},
          data: w,
          updatedAt: new Date(),
        };
      }),
    );

    await chunkInsert(
      tx,
      locations,
      Object.entries(s.locations ?? {}).map(([code, raw]) => {
        const l = raw as Record<string, unknown>;
        return {
          code,
          wh: (l.wh as string) ?? null,
          zone: (l.zone as string) ?? null,
          rack: (l.rack as string) ?? null,
          shelf: (l.shelf as string) ?? null,
          slot: (l.slot as string) ?? null,
          type: (l.type as string) ?? null,
          note: (l.note as string) ?? null,
          data: l,
          updatedAt: new Date(),
        };
      }),
    );

    await chunkInsert(
      tx,
      employees,
      Object.entries(s.employees ?? {}).map(([id, raw]) => {
        const e = raw as Record<string, unknown>;
        return {
          id,
          name: (e.name as string) ?? null,
          role: (e.role as string) ?? null,
          data: e,
          updatedAt: new Date(),
        };
      }),
    );

    // 6) simple keyed maps
    for (const [tbl, map] of [
      [vehicles, s.vehicles],
      [doRecords, s.doRecords],
      [putaway, s.putaway],
      [inventory, s.inventory],
    ] as const) {
      await chunkInsert(
        tx,
        tbl,
        Object.entries(map ?? {}).map(([id, raw]) => ({ id, data: raw, updatedAt: new Date() })),
      );
    }

    // 7) gates lookup (gate# → warehouseId)
    await chunkInsert(
      tx,
      gates,
      Object.entries(s.gates ?? {})
        .map(([g, wh]) => ({ gateNo: toInt(g)!, warehouseId: (wh as string) ?? null }))
        .filter((r) => r.gateNo !== null),
    );

    // 8) event stream (preserve array order → serial id order)
    await chunkInsert(
      tx,
      events,
      (s.events ?? []).map((e) => {
        const ev = e as Record<string, unknown>;
        return { ts: toDate(ev.ts) ?? new Date(), data: ev };
      }),
    );

    // 9) audit log (preserve array order; original stores newest-first)
    await chunkInsert(
      tx,
      auditLog,
      (s.auditLog ?? []).map((a) => {
        const e = a as Record<string, unknown>;
        return {
          action: (e.action as string) ?? null,
          actor: (e.recorder as string) ?? null,
          entityId: (e.itemId as string) ?? null,
          entityName: (e.itemName as string) ?? null,
          before: (e.before as object) ?? null,
          after: (e.after as object) ?? null,
          data: e,
          ts: toDate(e.ts) ?? new Date(),
        };
      }),
    );
  });
}

/** Insert in bounded chunks to stay well under Postgres' bind-parameter limit. */
async function chunkInsert(tx: any, table: any, rows: any[], size = 400): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    if (slice.length) await tx.insert(table).values(slice);
  }
}
