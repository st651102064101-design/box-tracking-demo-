import { Router } from 'express';
import { z } from 'zod';
import { env } from '../env.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/client.js';
import { auditLog, boxes, gatePendingReads, gates, rfidGateAutoSessions, warehouses } from '../db/schema.js';
import { resolveBoxesByCodes } from '../services/rfid.js';
import { and, eq } from 'drizzle-orm';
import { bump, publishLprDetection } from '../lib/bus.js';
import { gateOut } from '../services/gate.js';

export const lprRouter = Router();

const lprPayloadSchema = z.object({
  eventId: z.string().min(1).max(100),
  cameraId: z.string().min(1).max(100),
  plateNumber: z.string().trim().min(2).max(24).transform((value) => value.toUpperCase().replace(/\s+/g, '')),
  confidence: z.number().min(0).max(1),
  /** Physical DB Gate ID.  Cameras must send a JSON integer (e.g. 2), never
   * a display label such as "Gate 2" that can drift from master data. */
  gateId: z.number().int().positive(),
  timestamp: z.string().datetime({ offset: true }),
  vehicleColor: z.string().min(1).max(40),
  vehicleType: z.string().max(40).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  // Image data is accepted only for compatibility with cameras, then dropped.
  // Operational traceability stores text metadata (plate/time/camera/gate).
  plateImage: z.object({
    url: z.string().url().optional(),
    base64: z.string().max(512_000).optional(),
    mimeType: z.enum(['image/jpeg', 'image/png']).default('image/jpeg'),
  }).optional(),
});

type LprDecision = {
  status: 'success' | 'review';
  action: 'open_gate' | 'manual_review';
  eventId: string;
  gateId: number;
  plateNumber: string;
  matchedRfid: boolean;
  reason: string;
  rfidTags?: string[];
};

// MOCK ONLY: in production replace this map with a short-lived DB/Redis query,
// e.g. SELECT from rfid_gate_reads where gate_id + expected_plate match and
// read_at is within ±30 seconds. The RFID workflow should write that expected
// plate when a shipment/vehicle session is staged.
const expectedRfidReads = new Map<string, { plateNumber: string; epc: string; seenAt: number }>([
  ['GATE-1', { plateNumber: '1กข1234', epc: 'BOX-001', seenAt: Date.now() }],
]);
const recentRfidReads = new Map<string, { tags: string[]; seenAt: number }>();
const processedEvents = new Map<string, LprDecision>();
const RFID_MATCH_WINDOW_MS = 30_000;
const MIN_AUTO_OPEN_CONFIDENCE = 0.85;

/** Called by the FX9600 receiver for every decoded read. In production this
 * short-lived cache should be backed by Redis/DB and joined to the staged
 * vehicle session (plate + gate), but it deliberately keeps the simulator
 * dependency-free. */
export function recordRfidObservation(gateId: string, tags: string[], seenAt = Date.now()) {
  recentRfidReads.set(gateId, { tags: Array.from(new Set(tags)).slice(0, 100), seenAt });
}

lprRouter.post('/', asyncHandler(async (req, res) => {
  if (req.get('X-LPR-Webhook-Secret') !== env.lprWebhookSecret) {
    return res.status(401).json({ status: 'error', error: 'invalid_webhook_secret' });
  }

  const parsed = lprPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 'error', error: 'invalid_lpr_payload', issues: parsed.error.issues });
  }

  const payload = parsed.data;
  /* A camera may only report to a gate that exists in the WMS master.  This
     is the binding point for LPR -> DB Gate and prevents a typo/camera label
     from being correlated with another physical lane. */
  const db = getDb();
  const gateNo = payload.gateId;
  const gate = (await db.select().from(gates).where(eq(gates.gateNo, gateNo)).limit(1))[0];
  if (!gate) throw httpError(404, `ไม่พบ DB Gate ${gateNo} สำหรับ LPR camera`, 'lpr_gate_not_found');
  const gateKey = `GATE-${gateNo}`;
  const duplicate = processedEvents.get(payload.eventId);
  if (duplicate) return res.status(200).json({ ...duplicate, duplicate: true });

  // Real-world correlation: the LPR read may open the barrier only when an
  // RFID event at the same gate expects the same vehicle within a small time
  // window. This prevents a high-confidence but unrelated plate from opening.
  const expected = expectedRfidReads.get(gateKey);
  const recent = recentRfidReads.get(gateKey);
  const recentRfid = recent && Math.abs(Date.parse(payload.timestamp) - recent.seenAt) <= RFID_MATCH_WINDOW_MS ? recent : undefined;
  const stagedPlateMatches = Boolean(
    expected
      && expected.plateNumber.toUpperCase().replace(/\s+/g, '') === payload.plateNumber
      && Math.abs(Date.parse(payload.timestamp) - expected.seenAt) <= RFID_MATCH_WINDOW_MS,
  );
  // A live FX9600 observation proves the vehicle is physically at this gate;
  // the staged plate/session is what should be joined here in production.
  const matchedRfid = Boolean(recentRfid || stagedPlateMatches);
  let mayOpen = matchedRfid && payload.confidence >= MIN_AUTO_OPEN_CONFIDENCE;
  const autoShippedTags: string[] = [];
  /* Outbound RFID mode stages the customer first; LPR supplies the plate.
     When both signals arrive within the correlation window, complete the
     shipment here so the barrier controller can act without a second click. */
  if (mayOpen && payload.direction !== 'inbound' && recentRfid?.tags?.length) {
    const session = (await db.select().from(rfidGateAutoSessions).where(eq(rfidGateAutoSessions.gateNo, gateNo)).limit(1))[0];
    const gateRow = (await db.select().from(gates).where(eq(gates.gateNo, gateNo)).limit(1))[0];
    const warehouse = gateRow?.warehouseId
      ? (await db.select().from(warehouses).where(eq(warehouses.id, gateRow.warehouseId)).limit(1))[0]
      : undefined;
    const gateTypes = warehouse?.gateTypes && typeof warehouse.gateTypes === 'object'
      ? warehouse.gateTypes as Record<string, unknown> : {};
    const gateDirection = String(gateTypes[String(gateNo)] ?? warehouse?.gateType ?? 'both');
    const bidirectionalModes = warehouse?.data && typeof warehouse.data === 'object'
      ? ((warehouse.data as Record<string, unknown>).gateBidirectionalModes as Record<string, unknown> | undefined) : undefined;
    const requiresScreenConfirmation = gateDirection === 'both'
      && String(bidirectionalModes?.[String(gateNo)] ?? 'screen') === 'screen';
    if (!requiresScreenConfirmation && session?.direction === 'out' && session.customer && session.expiresAt.getTime() > Date.now()) {
      await db.update(rfidGateAutoSessions).set({ plate: payload.plateNumber, updatedAt: new Date(), updatedBy: payload.cameraId }).where(eq(rfidGateAutoSessions.gateNo, gateNo));
      try {
        const shipped = await gateOut(db, { tags: recentRfid.tags, gate: gateNo, customer: session.customer, doNo: session.doNo ?? undefined, po: session.po ?? undefined, plate: payload.plateNumber, recorder: session.recorder ?? 'LPR + FX9600', device: payload.cameraId });
        autoShippedTags.push(...shipped.shipped);
        for (const tag of autoShippedTags) await db.delete(gatePendingReads).where(and(eq(gatePendingReads.gateNo, gateNo), eq(gatePendingReads.tag, tag)));
      } catch (error) {
        mayOpen = false;
        console.error('[lpr-auto-out] unable to ship correlated RFID tags', error);
      }
    }
  }
  const decision: LprDecision = {
    status: mayOpen ? 'success' : 'review',
    action: mayOpen ? 'open_gate' : 'manual_review',
    eventId: payload.eventId,
    gateId: gateNo,
    plateNumber: payload.plateNumber,
    matchedRfid,
    reason: !matchedRfid ? 'no_matching_recent_rfid' : 'plate_and_rfid_matched',
    rfidTags: autoShippedTags.length ? autoShippedTags : (recentRfid?.tags ?? (stagedPlateMatches && expected ? [expected.epc] : [])),
  };

  processedEvents.set(payload.eventId, decision);
  const ts = new Date(payload.timestamp);
  const lprEvent = {
    dir: 'lpr',
    ts: ts.toISOString(),
    eventId: payload.eventId,
    cameraId: payload.cameraId,
    gate: gateKey,
    gateNo,
    plateNumber: payload.plateNumber,
    confidence: payload.confidence,
    vehicleColor: payload.vehicleColor,
    vehicleType: payload.vehicleType,
    direction: payload.direction,
    // Never retain image URL/base64 in PostgreSQL or the browser state.
    matchedRfid,
    rfidTags: decision.rfidTags,
    action: decision.action,
  };
  // Camera/LPR events are automated system telemetry, not operator audit
  // records. Keep the text-only evidence on the affected boxes only.
  try {
    const db = getDb();
    if (decision.rfidTags?.length) {
      const { resolved } = await resolveBoxesByCodes(db, decision.rfidTags);
      for (const row of resolved.values()) {
        const history = Array.isArray(row.history) ? [...row.history, lprEvent] : [lprEvent];
        await db.update(boxes).set({ history, data: { ...(row.data as Record<string, unknown>), history }, updatedAt: ts }).where(eq(boxes.tag, row.tag));
      }
    }
  } catch (error) {
    // Camera admission must still return its decision if box-history
    // persistence is temporarily unavailable; the error remains in logs.
    console.error('[lpr-history] unable to persist detection', error);
  }
  publishLprDetection({ eventId: payload.eventId, gateId: String(gateNo), plateNumber: payload.plateNumber, confidence: payload.confidence, rfidTags: decision.rfidTags ?? [], ts: ts.toISOString() });
  bump();
  return res.status(mayOpen ? 200 : 202).json(decision);
}));

/* Operator-facing history removal. The original camera admission remains in
   audit_log (an immutable operational audit trail); this only removes an
   incorrectly attached image/plate from a box's convenience history panel. */
lprRouter.delete('/boxes/:tag/events/:eventId', requireAuth, asyncHandler(async (req, res) => {
  const tag = String(req.params.tag ?? '').trim();
  const eventId = String(req.params.eventId ?? '').trim();
  const ts = typeof req.query.ts === 'string' ? req.query.ts : '';
  const db = getDb();
  const [row] = await db.select().from(boxes).where(eq(boxes.tag, tag)).limit(1);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'ไม่พบกล่อง' });

  const oldHistory = Array.isArray(row.history) ? row.history : [];
  let removed = false;
  const history = oldHistory.filter((item) => {
    const entry = item as Record<string, unknown>;
    const isLpr = entry?.dir === 'lpr';
    const matchesEvent = eventId !== 'legacy' && String(entry?.eventId ?? '') === eventId;
    const matchesLegacy = eventId === 'legacy' && ts !== '' && String(entry?.ts ?? '') === ts;
    if (isLpr && (matchesEvent || matchesLegacy) && !removed) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) return res.status(404).json({ error: 'not_found', message: 'ไม่พบประวัติ LPR ที่ต้องการลบ' });

  await db.update(boxes).set({
    history,
    data: { ...(row.data as Record<string, unknown>), history },
    updatedAt: new Date(),
  }).where(eq(boxes.tag, tag));
  await db.insert(auditLog).values({
    action: 'lpr_history_removed', actor: req.user!.username, entityId: tag, entityName: tag,
    before: { eventId: eventId === 'legacy' ? undefined : eventId, ts },
    data: { itemId: tag, itemName: tag, recorder: req.user!.username },
  });
  bump(req.get('X-Client-Id'));
  res.json({ ok: true });
}));

export default lprRouter;
