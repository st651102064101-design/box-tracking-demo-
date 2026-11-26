/**
 * Gate operations as a first-class REST service — the same status transitions
 * the legacy UI performs client-side, but executed server-side so physical RFID
 * readers / integrations can POST scans directly.
 *
 * Box lifecycle (mirrors the original app):
 *   pending → (label) → out → warehouse → out → …   (cycles++ on each return)
 */
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { boxes, customers, config, gates, events, doRecords, employees } from '../db/schema.js';
import { httpError } from '../middleware/error.js';
import { resolveBoxesByCodes } from './rfid.js';
import { sendGateInNotifications, sendGateOutLineNotification } from './autoLineNotifications.js';

const DAY = 86_400_000;
const iso = () => new Date().toISOString();
const pad = (n: number, w: number) => String(n).padStart(w, '0');
/** Same shape as the legacy web UI's genDocNo('DO') (DO-YYYY-MM-DD-HHMMSS) —
 *  the fallback when a caller (PDA, an integration) ships a batch without its
 *  own DO number. It used to be `DO-${Date.now()}`, a raw epoch-ms stamp that
 *  looked nothing like the readable numbers the web app generates for the
 *  same kind of record. */
function genDoNo(): string {
  const d = new Date();
  return (
    `DO-${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}-` +
    `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`
  );
}

async function warehouseOfGate(db: DB, gate: number): Promise<string> {
  const [row] = await db.select().from(gates).where(eq(gates.gateNo, gate));
  return row?.warehouseId ?? '';
}

/**
 * A scan has to land at a gate that actually exists. Without this, a mistyped
 * or stale gate number (a handheld still configured for a removed gate, an
 * integration with a typo) was accepted with an empty warehouse: the box
 * became 'warehouse' with no warehouse at all, and because an unknown
 * warehouse "fails open" in currentWhOf, it could then be shipped from any
 * gate. Reject it up front, before anything is touched.
 */
async function requireWarehouseOfGate(db: DB, gate: number): Promise<string> {
  const wh = await warehouseOfGate(db, gate);
  if (!wh) throw httpError(404, `ไม่พบประตูหมายเลข ${gate} ในระบบ — ตรวจสอบเลขประตูหรือเพิ่มประตูในข้อมูลหลักก่อน`, 'gate_not_found');
  return wh;
}

/**
 * Best-effort "which warehouse does this box currently belong to" — the typed
 * `location.wh` when it has one (shelved), otherwise the `wh` off the box's
 * most recent inbound history entry. A box received into pending-putaway
 * reaches `status: 'warehouse'` without a location stamped, so `location.wh`
 * alone under-reports which boxes are this warehouse's. Empty string means
 * genuinely unknown — callers must treat that as "don't know, don't block".
 */
function currentWhOf(row: typeof boxes.$inferSelect): string {
  const locWh = (row.location as Record<string, unknown> | null)?.wh;
  if (typeof locWh === 'string' && locWh) return locWh;
  const history = Array.isArray(row.history) ? (row.history as Record<string, unknown>[]) : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if ((h.dir === 'in' || h.dir === 'in-new') && typeof h.wh === 'string' && h.wh) return h.wh;
  }
  return '';
}

/** Who performed a scan, as recorded on every box's history and event row. */
interface Operator {
  employeeId: string;
  recorder: string;
}

/**
 * Resolves the operator against the employee master.
 *
 * Handheld clients identify people by badge and send the employee id, so the
 * name written into history is looked up here rather than trusted from the
 * request — and an employee who is on leave or off the payroll is refused,
 * which makes the WMS "สถานะ" field an actual off-switch for the gate.
 *
 * `employeeId` stays optional so server-side integrations and the legacy web
 * UI, which only ever had a free-text recorder, keep working unchanged.
 */
async function resolveOperator(
  db: DB,
  employeeId: string | undefined,
  recorder: string | undefined,
): Promise<Operator> {
  if (!employeeId) return { employeeId: '', recorder: recorder ?? 'api' };

  const [row] = await db.select().from(employees).where(eq(employees.id, employeeId));
  if (!row) throw httpError(404, `ไม่พบพนักงานรหัส ${employeeId}`, 'employee_not_found');

  const data = (row.data ?? {}) as Record<string, unknown>;
  const status = typeof data.status === 'string' ? data.status : 'active';
  if (status !== 'active') {
    throw httpError(
      403,
      `${row.name ?? employeeId} ไม่อยู่ในสถานะปฏิบัติงาน — ติดต่อหัวหน้างาน`,
      'employee_inactive',
    );
  }
  return { employeeId: row.id, recorder: row.name ?? recorder ?? employeeId };
}

export interface GateOutInput {
  /** Barcodes and/or RFID reads (EPC/TID) — resolved against boxes before
   *  anything else, so a handheld never has to know which kind of scan it
   *  captured. See services/rfid.ts. */
  tags: string[];
  customer: string;
  gate: number;
  doNo?: string;
  po?: string;
  employeeId?: string;
  recorder?: string;
  plate?: string;
  driver?: string;
  vehicleType?: string;
  /** Service account of the terminal that sent this, taken from the JWT. */
  device?: string;
  /** Which client sent this — 'web' (PC) or 'pda' (handheld). */
  platform?: string;
}

export async function gateOut(db: DB, input: GateOutInput) {
  const { tags, customer, gate } = input;
  await requireWarehouseOfGate(db, gate);
  const operator = await resolveOperator(db, input.employeeId, input.recorder);
  const { employeeId, recorder } = operator;
  const device = input.device ?? '';
  const platform = input.platform ?? '';
  const doNo = input.doNo ?? genDoNo();
  const po = input.po ?? '';
  const plate = input.plate ?? '';
  const driver = input.driver ?? '';
  const vehicleType = input.vehicleType ?? '';

  const [cust] = await db.select().from(customers).where(eq(customers.id, customer));
  if (!cust) throw httpError(404, 'ไม่พบลูกค้า', 'customer_not_found');
  const [cfg] = await db.select().from(config);
  const { resolved, missing } = await resolveBoxesByCodes(db, tags);
  if (missing.length) throw httpError(404, `ไม่พบกล่อง: ${missing.join(', ')}`, 'box_not_found');
  // Barcode + RFID for the same box in one batch (mis-scan, or an operator
  // double-checking) must not ship it twice — dedupe on the canonical tag.
  const found = new Map(Array.from(resolved.values()).map((r) => [r.tag, r]));
  const canonicalTags = Array.from(new Set(Array.from(resolved.values()).map((r) => r.tag)));

  /* Only a box actually sitting in the warehouse can ship — mirrors scanOut()
   * in legacy.html exactly (out/lost/pending/hold/damage are all refused
   * there with a specific reason). This endpoint has no client-side gate in
   * front of it (a physical RFID reader or PDA calls it directly), so the
   * same business rule has to be enforced here too, or Hold/Damage/Lost stop
   * meaning anything the moment a scan comes from a device instead of the
   * web UI. */
  const NOT_SHIPPABLE: Record<string, string> = {
    out: 'ออกไปแล้ว (ยังไม่คืน)',
    lost: 'ถูกตีเป็นสูญหาย',
    pending: 'ยังไม่ติด Tag / ยังไม่เคยผ่าน Gate เข้าคลัง',
    hold: 'ถูกพักการใช้งาน (Hold) — ปลด Hold ก่อนจึงจ่ายออกได้',
    damage: 'สถานะชำรุด (Damage) — จ่ายออกไม่ได้',
  };
  const blocked = canonicalTags
    .map((tag) => ({ tag, status: found.get(tag)!.status }))
    .filter((b) => b.status !== 'warehouse');
  if (blocked.length) {
    const detail = blocked.map((b) => `${b.tag} (${NOT_SHIPPABLE[b.status] ?? b.status})`).join(', ');
    throw httpError(409, `จ่ายออกไม่ได้: ${detail}`, 'box_not_shippable');
  }

  const wh = await requireWarehouseOfGate(db, gate);
  // A box actually sitting in warehouse-A's inventory can't ship from
  // warehouse-B's gate — the same "this device belongs to one warehouse" rule
  // the PDA enforces client-side, repeated here since a physical reader or
  // other integration can call this endpoint with no PDA in front of it.
  // currentWhOf empty means genuinely unknown — fail open on that data gap
  // rather than block a legitimate shipment.
  const wrongWh = canonicalTags
    .map((tag) => ({ tag, row: found.get(tag)! }))
    .filter((b) => {
      const cwh = currentWhOf(b.row);
      return cwh !== '' && cwh !== wh;
    });
  if (wrongWh.length) {
    const detail = wrongWh.map((b) => `${b.tag} (${currentWhOf(b.row)})`).join(', ');
    throw httpError(409, `จ่ายออกไม่ได้ — ไม่ใช่กล่องของคลังนี้: ${detail}`, 'box_wrong_warehouse');
  }
  const returnDays = cust.returnDays ?? cfg?.agingDays ?? 15;
  const outTs = iso();
  const dueTs = new Date(Date.now() + returnDays * DAY).toISOString();
  const shipped: string[] = [];

  await db.transaction(async (tx) => {
    for (const tag of canonicalTags) {
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
      b.plate = plate;
      b.driver = driver;
      b.vehicleType = vehicleType;
      const history = Array.isArray(b.history) ? (b.history as unknown[]) : [];
      history.push({
        dir: 'out',
        ts: outTs,
        do: doNo,
        po,
        customer,
        gate,
        wh,
        recorder,
        employeeId,
        device,
        platform,
        dueAt: dueTs,
        returnDays,
        plate,
        driver,
        vehicleType,
      });
      b.history = history;

      await tx
        .update(boxes)
        .set({
          status: 'out',
          slotId: null,
          customer,
          doNo,
          po,
          outGate: gate,
          outWh: wh,
          outAt: new Date(outTs),
          dueAt: new Date(dueTs),
          lastSeenAt: new Date(outTs),
          history,
          data: b,
          updatedAt: new Date(),
        })
        .where(eq(boxes.tag, tag));

      await tx.insert(events).values({
        ts: new Date(outTs),
        platform: platform || null,
        data: {
          ts: outTs,
          dir: 'out',
          tag,
          type: row.type,
          do: doNo,
          po,
          customer,
          customerName: cust.name,
          gate,
          wh,
          recorder,
          employeeId,
          device,
          platform,
          plate,
          driver,
          vehicleType,
        },
      });
      shipped.push(tag);
    }

    await tx
      .insert(doRecords)
      .values({ id: doNo, data: { customer, po, returnDays } })
      .onConflictDoUpdate({ target: doRecords.id, set: { data: { customer, po, returnDays } } });
  });

  // This happens only after the stock transaction commits. Notification
  // failure is persisted for retry and never rolls the physical movement back.
  await sendGateOutLineNotification(db, {
    customerId: cust.id,
    customerName: cust.name ?? cust.id,
    lineUserId: cust.lineUserId,
    contactEmail: cust.contactEmail,
    doNo,
    tags: shipped,
    dueAt: dueTs,
    plate,
  });

  return { ok: true, doNo, shipped, dueAt: dueTs, count: shipped.length };
}

export interface GateInInput {
  /** Barcodes and/or RFID reads (EPC/TID) — see GateOutInput.tags. */
  tags: string[];
  gate: number;
  employeeId?: string;
  recorder?: string;
  plate?: string;
  driver?: string;
  vehicleType?: string;
  /** Per-tag condition (see gateInSchema), keyed by whatever canonical tag
   *  resolveBoxesByCodes resolves the operator's scan to. */
  conditions?: Record<string, 'hold' | 'damage'>;
  /** Service account of the terminal that sent this, taken from the JWT. */
  device?: string;
  /** Which client sent this — 'web' (PC) or 'pda' (handheld). */
  platform?: string;
  /** One shelf position for the whole batch — see gateInLocationSchema.
   *  Omitted means "leave wherever it already was" (pending-putaway). Never
   *  applied to a tag that landed on hold/damage instead of warehouse: a
   *  box set aside for inspection isn't the box a shelf was just picked
   *  for, and stamping the location on it anyway would just be wrong data
   *  the moment the flag gets cleared and it actually gets put away. */
  location?: { zone?: string; rack?: string; shelf?: string; slot?: string };
}

export async function gateIn(db: DB, input: GateInInput) {
  const { tags, gate } = input;
  const wh = await requireWarehouseOfGate(db, gate);
  const { employeeId, recorder } = await resolveOperator(db, input.employeeId, input.recorder);
  const device = input.device ?? '';
  const platform = input.platform ?? '';
  const plate = input.plate ?? '';
  const driver = input.driver ?? '';
  const vehicleType = input.vehicleType ?? '';
  const conditions = input.conditions ?? {};
  const inTs = iso();
  const { resolved, missing } = await resolveBoxesByCodes(db, tags);
  // Same-box dedupe as gateOut — see comment there.
  const canonicalTags = Array.from(new Set(Array.from(resolved.values()).map((r) => r.tag)));
  const found = new Map(Array.from(resolved.values()).map((r) => [r.tag, r]));
  const received: string[] = [];
  // Reported as the operator's own scanned code (barcode or RFID, whichever
  // they actually shot), not a canonical tag that was never resolved.
  const unknown: string[] = missing;
  const returnedByCustomer = new Map<string, { doNo: string | null; tags: string[]; plate: string }>();

  /* A box that never left is already accounted for — scanning it in again (a
   * mis-scan, or a repeated receipt) must not silently re-stamp lastSeenAt and
   * log a second "received" event as if a shipment had just come off a truck.
   * Mirrors gateOut's NOT_SHIPPABLE guard: reject the whole batch up front,
   * before any row is touched. Only 'warehouse' is checked — pending/hold/
   * damage/lost boxes are exactly what receiving is *for*. */
  const alreadyIn = canonicalTags.map((tag) => found.get(tag)!).filter((row) => row.status === 'warehouse');
  if (alreadyIn.length) {
    const detail = alreadyIn.map((row) => `${row.tag} (อยู่ในคลังอยู่แล้ว)`).join(', ');
    throw httpError(409, `รับเข้าไม่ได้: ${detail}`, 'box_already_in_warehouse');
  }

  // A box is received wherever it physically shows up: shipping out from
  // warehouse-A and arriving at warehouse-B is a real inter-warehouse transfer,
  // not a mis-scan, so `wh` simply becomes the box's new warehouse regardless
  // of outWh. Gate Out keeps its own "only ship what is in this warehouse"
  // guard, which is what stops a genuine mis-scan from moving absent stock.

  await db.transaction(async (tx) => {
    for (const tag of canonicalTags) {
      const row = found.get(tag)!;
      const b = { ...(row.data as Record<string, unknown>) };
      const wasOut = b.status === 'out';
      if (wasOut && row.customer) {
        const key = `${row.customer}\n${row.doNo ?? ''}`;
        const group = returnedByCustomer.get(key) ?? { doNo: row.doNo, tags: [], plate };
        group.tags.push(tag);
        returnedByCustomer.set(key, group);
      }
      // A box the operator flagged while scanning it in lands on 'hold' or
      // 'damage' instead of 'warehouse' — same statuses the box list already
      // filters by (see legacy.html's filtBoxStatus) — so it can't ship back
      // out (gateOut's NOT_SHIPPABLE map) until someone clears the flag.
      const condition = conditions[tag];
      const status = condition ?? 'warehouse';
      b.status = status;
      b.cycles = (Number(b.cycles) || 0) + (wasOut ? 1 : 0);
      b.lastSeenAt = inTs;
      // Only a box actually landing on 'warehouse' gets the chosen shelf —
      // see the docstring on GateInInput.location.
      const location =
        !condition && input.location
          ? { wh, zone: input.location.zone ?? '', rack: input.location.rack ?? '', shelf: input.location.shelf ?? '', slot: input.location.slot ?? '', gate: null, ts: inTs }
          : undefined;
      // A returned box flagged hold/damage must not keep (or gain) a real rack
      // position — it is not sellable/shippable stock, so it cannot sit on
      // screen looking like ordinary shelved inventory. Park it in quarantine;
      // a real position is only assigned again once the flag is cleared and the
      // box goes through the normal putaway endpoint.
      let locationDirty = false;
      if (condition === 'hold' || condition === 'damage') {
        b.location = { wh: '', zone: 'QUARANTINE_ZONE', rack: '', shelf: '', slot: '', gate: null, ts: inTs };
        locationDirty = true;
      }
      if (location) {
        b.location = location;
        locationDirty = true;
      }
      // Received at a different warehouse than the one it is still recorded in:
      // the old zone/rack/shelf/slot belongs to that other building, so it cannot
      // travel with the box. Re-home it on this warehouse with no position
      // (pending putaway) — otherwise the stale location.wh keeps winning in
      // currentWhOf and gateOut would refuse to ship it from where it stands.
      const curWh = (b.location as Record<string, unknown> | null)?.wh;
      if (!location && condition !== 'hold' && condition !== 'damage' && typeof curWh === 'string' && curWh && curWh !== wh) {
        b.location = { wh, zone: '', rack: '', shelf: '', slot: '', gate: null, ts: inTs };
        locationDirty = true;
      }
      b.plate = plate;
      b.driver = driver;
      b.vehicleType = vehicleType;
      // Who is returning it — captured before the trip fields are cleared.
      const returned = wasOut ? { customer: row.customer ?? '', do: row.doNo ?? '' } : { customer: '', do: '' };
      // Every inbound path in the legacy web UI clears these on return (see
      // legacy.html ~5552/5559/7296/4899) — a box back in the warehouse must
      // stop reporting the customer/DO/due-date from its last trip out, or
      // it keeps looking shipped even though status already says otherwise.
      b.customer = '';
      b.do = '';
      b.po = '';
      b.outGate = null;
      b.outWh = '';
      b.outAt = null;
      b.dueAt = null;
      const history = Array.isArray(b.history) ? (b.history as unknown[]) : [];
      history.push({
        dir: 'in',
        ts: inTs,
        ...returned,
        gate,
        wh,
        recorder,
        employeeId,
        device,
        platform,
        plate,
        driver,
        vehicleType,
        ...(condition ? { condition } : {}),
        ...(location ? { loc: location } : {}),
      });
      b.history = history;

      await tx
        .update(boxes)
        .set({
          status,
          cycles: (row.cycles ?? 0) + (wasOut ? 1 : 0),
          lastSeenAt: new Date(inTs),
          customer: null,
          doNo: null,
          po: null,
          outGate: null,
          outWh: null,
          outAt: null,
          dueAt: null,
          // Only touch the typed location column when this scan actually decided a
          // position — an explicit shelf, the quarantine park, or the re-home
          // above. An ordinary inbound with none of those still goes through the
          // dedicated putaway endpoint, same as always.
          ...(locationDirty ? { location: b.location } : {}),
          history,
          data: b,
          updatedAt: new Date(),
        })
        .where(eq(boxes.tag, tag));

      await tx.insert(events).values({
        ts: new Date(inTs),
        platform: platform || null,
        data: {
          ts: inTs,
          dir: wasOut ? 'in' : 'in-new',
          tag,
          type: row.type,
          do: returned.do,
          customer: returned.customer,
          gate,
          wh,
          recorder,
          employeeId,
          device,
          platform,
          plate,
          driver,
          vehicleType,
          ...(condition ? { condition } : {}),
          ...(location ? { loc: location } : {}),
        },
      });
      received.push(tag);
    }
  });

  for (const [key, group] of returnedByCustomer) {
    const customerId = key.split('\n', 1)[0];
    const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
    if (!customer) continue;
    await sendGateInNotifications(db, {
      customerId,
      customerName: customer.name ?? customerId,
      lineUserId: customer.lineUserId,
      contactEmail: customer.contactEmail,
      doNo: group.doNo,
      tags: group.tags,
      receivedAt: inTs,
      plate: group.plate,
    });
  }

  return { ok: true, received, unknown, count: received.length };
}
