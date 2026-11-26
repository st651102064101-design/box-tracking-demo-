/** The fit rules applied to what the database and the web upload hold. */
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { boxes, racks, slots } from '../db/schema.js';
import {
  boxSize, fitsSlot, fitsSomeSlot, largestLimit, sizeText, type Size, type SlotSize,
} from '../lib/boxFit.js';
import { httpError } from '../middleware/error.js';
import type { StatePayload } from '../validators/schemas.js';
import { deriveWarehouseGeometry, parseBoxTypeDimensionsCm } from './warehouseGeometry.js';
import type { RejectedGroup } from './stateGuard.js';

type Dict = Record<string, unknown>;

export const allSlots = (db: DB): Promise<SlotSize[]> =>
  db.select({ widthCm: slots.widthCm, heightCm: slots.heightCm, depthCm: slots.depthCm }).from(slots);

/** Throws when `dim` is a real size that no slot can take. */
export async function requireTypeFits(db: DB, dim: unknown): Promise<void> {
  const size = parseBoxTypeDimensionsCm(dim);
  if (!size) return;
  const known = await allSlots(db);
  if (fitsSomeSlot(size, known)) return;
  throw httpError(409, `ขนาด ${sizeText(size)} ซม. ใหญ่กว่าทุกช่องแร็ค (สูงสุด ${sizeText(largestLimit(known))} ซม.)`, 'box_too_big');
}

/** Boxes carry their own size; correcting a type corrects them. */
export async function resizeBoxesOfType(db: DB, type: string, size: Size): Promise<void> {
  const next = { widthCm: size.width, heightCm: size.height, depthCm: size.depth };
  for (const row of await db.select().from(boxes).where(eq(boxes.type, type))) {
    await db.update(boxes)
      .set({ ...next, data: { ...(row.data as Dict), ...next }, updatedAt: new Date() })
      .where(eq(boxes.tag, row.tag));
  }
}

/** The slot a typed location points at, if the Location Master defines it. */
export async function findSlot(db: DB, wh: string, at: { zone?: string; rack?: string; shelf?: string; slot?: string }) {
  if (!at.zone || !at.rack || !at.shelf || !at.slot) return undefined;
  const [row] = await db
    .select({ widthCm: slots.widthCm, heightCm: slots.heightCm, depthCm: slots.depthCm })
    .from(slots)
    .innerJoin(racks, eq(slots.rackId, racks.id))
    .where(and(eq(racks.warehouseId, wh), eq(racks.zone, at.zone), eq(racks.code, at.rack),
      eq(slots.shelfCode, at.shelf), eq(slots.slotCode, at.slot)));
  return row;
}

/**
 * The web app's whole-state upload: refuse new or resized types that fit no slot,
 * and moves into a slot the box does not fit. Only changes are judged, so data
 * that was already wrong never blocks an unrelated save. Boxes of a resized type
 * take its new size.
 */
export async function refuseOversize(
  db: DB,
  payload: StatePayload,
  stored: Dict,
): Promise<{ payload: StatePayload; rejected: RejectedGroup[] }> {
  const [existingRacks, existingSlots] = await Promise.all([db.select().from(racks), db.select().from(slots)]);
  const geometry = deriveWarehouseGeometry(payload.locations ?? {}, payload.boxes ?? {}, payload.boxtypes ?? {}, existingRacks, existingSlots);
  const slotById = new Map(geometry.slotRows.map((s) => [s.id, s]));
  const storedTypes = (stored.boxtypes ?? {}) as Record<string, Dict>;
  const storedBoxes = (stored.boxes ?? {}) as Record<string, Dict>;
  const types = { ...(payload.boxtypes as Record<string, Dict>) };
  const next = { ...(payload.boxes as Record<string, Dict>) };
  const badTypes: string[] = [];
  const resized = new Map<string, Size>();

  for (const [id, type] of Object.entries(types)) {
    const before = storedTypes[id];
    if (before && before.dim === type.dim) continue;
    const size = parseBoxTypeDimensionsCm(type.dim);
    if (!size) continue;
    if (fitsSomeSlot(size, geometry.slotRows)) {
      if (before) resized.set(id, size);
      continue;
    }
    badTypes.push(`${id} (${sizeText(size)})`);
    if (before) types[id] = { ...type, dim: before.dim };
    else delete types[id];
  }

  const tooBig: string[] = [];
  for (const [tag, box] of Object.entries(next)) {
    const size = resized.get(String(box.type));
    if (size) next[tag] = { ...box, widthCm: size.width, heightCm: size.height, depthCm: size.depth };
    else if (!payload.restore) {
      /* A box's size is not edited on this screen; a page holding an older
         size must not put it back after the type was corrected. */
      const kept = storedBoxes[tag];
      if (kept && ['widthCm', 'heightCm', 'depthCm'].some((k) => kept[k] !== undefined && kept[k] !== box[k])) {
        next[tag] = { ...box, widthCm: kept.widthCm, heightCm: kept.heightCm, depthCm: kept.depthCm };
      }
    }
    const model = geometry.boxesByTag.get(tag);
    if (!model?.slotId) continue;
    const before = storedBoxes[tag];
    if (before && before.slotId === model.slotId) continue;
    /* Unchanged boxes saved without a slot id still resolve to the same place. */
    if (before && JSON.stringify(before.location) === JSON.stringify(box.location)) continue;
    const slot = slotById.get(model.slotId)!;
    if (fitsSlot(size ?? boxSize(model), slot)) continue;
    tooBig.push(tag);
    if (before) next[tag] = before;
    else next[tag] = { ...box, slotId: null, location: { ...(box.location as Dict), zone: '', rack: '', shelf: '', slot: '' } };
  }

  const group = (key: string, label: string, message: string): RejectedGroup => ({ key, label, required: [], message });
  const limit = sizeText(largestLimit(geometry.slotRows));
  return {
    payload: { ...payload, boxtypes: types, boxes: next },
    rejected: [
      ...(badTypes.length ? [group('boxTypeSize', 'ขนาดประเภทกล่อง', `ใหญ่กว่าทุกช่องแร็ค (สูงสุด ${limit} ซม.): ${badTypes.join(', ')}`)] : []),
      ...(tooBig.length ? [group('boxTooBig', 'กล่องใหญ่เกินช่อง', `กล่องใหญ่เกินช่องที่เลือก: ${tooBig.join(', ')}`)] : []),
    ],
  };
}
