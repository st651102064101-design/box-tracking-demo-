import type { boxes, racks, slots } from '../db/schema.js';

type JsonRecord = Record<string, unknown>;
type ExistingRack = typeof racks.$inferSelect;
type ExistingSlot = typeof slots.$inferSelect;

export const CENTIMETRES_PER_METRE = 100;
export const DEFAULT_SLOT_CM = Object.freeze({ width: 110, height: 70, depth: 100 });
export const DEFAULT_BOX_CM = Object.freeze({ width: 60, height: 40, depth: 40 });

export interface RackGeometryRow extends Record<string, unknown> {
  id: string;
  warehouseId: string;
  zone: string;
  code: string;
  positionXCm: number;
  positionYCm: number;
  positionZCm: number;
  rotationYDeg: number;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  materialType: string;
  data: JsonRecord;
  updatedAt: Date;
}

export interface SlotGeometryRow extends Record<string, unknown> {
  id: string;
  rackId: string;
  shelfCode: string;
  slotCode: string;
  localXCm: number;
  localYCm: number;
  localZCm: number;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  status: 'empty' | 'full';
  data: JsonRecord;
  updatedAt: Date;
}

export interface BoxGeometryValues {
  slotId: string | null;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  materialType: string;
}

export interface DerivedWarehouseGeometry {
  rackRows: RackGeometryRow[];
  slotRows: SlotGeometryRow[];
  boxesByTag: Map<string, BoxGeometryValues>;
}

const natural = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const recordOf = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

const finite = (value: unknown): number | undefined => {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const positive = (value: unknown): number | undefined => {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
};

const text = (value: unknown): string => String(value ?? '').trim();

function pickNumber(objects: JsonRecord[], keys: string[], fallback: number, mustBePositive = false): number {
  for (const object of objects) {
    for (const key of keys) {
      const value = mustBePositive ? positive(object[key]) : finite(object[key]);
      if (value !== undefined) return value;
    }
  }
  return fallback;
}

/** Stable identity shared by the legacy Location Master and normalized rack table. */
export function rackGeometryId(warehouseId: string, zone: string, rackCode: string): string {
  return `${warehouseId}::${zone}::${rackCode}`;
}

/** Box Type dimensions are entered as กว้าง × ยาว × สูง in centimetres. */
export function parseBoxTypeDimensionsCm(value: unknown): { width: number; height: number; depth: number } | null {
  const parts = String(value ?? '')
    .trim()
    .replace(/[×X*]/g, 'x')
    .split('x')
    .map((part) => positive(part.trim()));
  if (parts.length !== 3 || parts.some((part) => part === undefined)) return null;
  return { width: parts[0]!, depth: parts[1]!, height: parts[2]! };
}

export function boxMaterialType(box: JsonRecord, boxType: JsonRecord): string {
  const explicit = text(box.materialType ?? box.material_type ?? boxType.materialType ?? boxType.material_type);
  if (explicit) return explicit;
  const name = text(boxType.name).toLowerCase();
  if (/กระดาษ|carton|cardboard/.test(name)) return 'carton';
  if (/พลาสติก|plastic|crate/.test(name)) return 'plastic_crate';
  if (/โลหะ|metal|steel/.test(name)) return 'metal_box';
  return 'generic';
}

export function boxGeometryValues(
  box: JsonRecord,
  boxType: JsonRecord,
  slotId: string | null,
): BoxGeometryValues {
  const dimensions = recordOf(box.dimensionsCm ?? box.sizeCm);
  const fromType = parseBoxTypeDimensionsCm(boxType.dim);
  return {
    slotId,
    widthCm: pickNumber([box, dimensions], ['widthCm', 'width', 'w'], fromType?.width ?? DEFAULT_BOX_CM.width, true),
    heightCm: pickNumber([box, dimensions], ['heightCm', 'height', 'h'], fromType?.height ?? DEFAULT_BOX_CM.height, true),
    depthCm: pickNumber([box, dimensions], ['depthCm', 'depth', 'length', 'l'], fromType?.depth ?? DEFAULT_BOX_CM.depth, true),
    materialType: boxMaterialType(box, boxType),
  };
}

type LocationEntry = { code: string; raw: JsonRecord; wh: string; zone: string; rack: string; shelf: string; slot: string };

/**
 * Convert the existing Location Master snapshot into normalized real-scale
 * rack/slot rows. Existing typed geometry wins over generated defaults, so a
 * normal legacy state save can never reset coordinates adjusted through the
 * geometry API.
 */
export function deriveWarehouseGeometry(
  locationMap: Record<string, unknown>,
  boxMap: Record<string, unknown>,
  boxTypeMap: Record<string, unknown>,
  existingRacks: ExistingRack[] = [],
  existingSlots: ExistingSlot[] = [],
): DerivedWarehouseGeometry {
  const now = new Date();
  const locations: LocationEntry[] = Object.entries(locationMap).flatMap(([key, value]) => {
    const raw = recordOf(value);
    const wh = text(raw.wh);
    const rack = text(raw.rack);
    if (!wh || !rack) return [];
    return [{
      code: text(raw.code) || key,
      raw,
      wh,
      zone: text(raw.zone),
      rack,
      shelf: text(raw.shelf) || '1',
      slot: text(raw.slot) || '1',
    }];
  });

  const existingRackById = new Map(existingRacks.map((rack) => [rack.id, rack]));
  const existingSlotById = new Map(existingSlots.map((slot) => [slot.id, slot]));
  const groups = new Map<string, LocationEntry[]>();
  for (const location of locations) {
    const id = rackGeometryId(location.wh, location.zone, location.rack);
    const rows = groups.get(id) ?? [];
    rows.push(location);
    groups.set(id, rows);
  }

  const groupEntries = [...groups.entries()].sort(([, a], [, b]) =>
    natural(a[0].wh, b[0].wh) || natural(a[0].zone, b[0].zone) || natural(a[0].rack, b[0].rack));
  const indexByWarehouse = new Map<string, number>();
  const rackRows: RackGeometryRow[] = [];
  const slotRows: SlotGeometryRow[] = [];
  const slotByIdentity = new Map<string, string>();

  for (const [rackId, rows] of groupEntries) {
    const first = rows[0];
    const existing = existingRackById.get(rackId);
    const rack3d = recordOf(first.raw.rack3d ?? first.raw.rackGeometry);
    const position = recordOf(rack3d.positionCm ?? rack3d.position);
    const dimensions = recordOf(rack3d.dimensionsCm ?? rack3d.sizeCm ?? rack3d.size);
    const shelves = [...new Set(rows.map((row) => row.shelf))].sort(natural);
    const slotsPerShelf = new Map<string, string[]>();
    for (const shelf of shelves) {
      slotsPerShelf.set(shelf, [...new Set(rows.filter((row) => row.shelf === shelf).map((row) => row.slot))].sort(natural));
    }
    const widestShelf = Math.max(1, ...[...slotsPerShelf.values()].map((items) => items.length));
    const warehouseIndex = indexByWarehouse.get(first.wh) ?? 0;
    indexByWarehouse.set(first.wh, warehouseIndex + 1);
    const defaultWidth = Math.max(140, widestShelf * 120 + 20);
    const defaultHeight = Math.max(110, shelves.length * 80 + 30);

    const rackRow: RackGeometryRow = {
      id: rackId,
      warehouseId: first.wh,
      zone: first.zone,
      code: first.rack,
      positionXCm: pickNumber([position, rack3d], ['x', 'positionXCm', 'positionX'], existing?.positionXCm ?? (warehouseIndex % 4) * 1000),
      positionYCm: pickNumber([position, rack3d], ['y', 'positionYCm', 'positionY'], existing?.positionYCm ?? 0),
      positionZCm: pickNumber([position, rack3d], ['z', 'positionZCm', 'positionZ'], existing?.positionZCm ?? Math.floor(warehouseIndex / 4) * 600),
      rotationYDeg: pickNumber([rack3d], ['rotationYDeg', 'rotationY', 'yaw'], existing?.rotationYDeg ?? 0),
      widthCm: pickNumber([dimensions, rack3d], ['width', 'widthCm'], existing?.widthCm ?? defaultWidth, true),
      heightCm: pickNumber([dimensions, rack3d], ['height', 'heightCm'], existing?.heightCm ?? defaultHeight, true),
      depthCm: pickNumber([dimensions, rack3d], ['depth', 'depthCm'], existing?.depthCm ?? 110, true),
      materialType: text(rack3d.materialType) || existing?.materialType || 'powder_coated_steel',
      data: { ...recordOf(existing?.data), source: 'location-master' },
      updatedAt: now,
    };
    rackRows.push(rackRow);

    const shelfIndex = new Map(shelves.map((shelf, index) => [shelf, index]));
    for (const location of rows.sort((a, b) => natural(a.shelf, b.shelf) || natural(a.slot, b.slot))) {
      const existingSlot = existingSlotById.get(location.code);
      const slot3d = recordOf(location.raw.slot3d ?? location.raw.slotGeometry);
      const local = recordOf(slot3d.localPositionCm ?? slot3d.localPosition ?? slot3d.positionCm);
      const size = recordOf(slot3d.dimensionsCm ?? slot3d.sizeCm ?? slot3d.size);
      const slotCodes = slotsPerShelf.get(location.shelf) ?? [location.slot];
      const slotIndex = Math.max(0, slotCodes.indexOf(location.slot));
      const defaultLocalX = (slotIndex - (slotCodes.length - 1) / 2) * 120;
      const defaultLocalY = 10 + ((shelfIndex.get(location.shelf) ?? 0) + 0.5) * 80;
      const row: SlotGeometryRow = {
        id: location.code,
        rackId,
        shelfCode: location.shelf,
        slotCode: location.slot,
        localXCm: pickNumber([local, slot3d], ['x', 'localXCm', 'localX'], existingSlot?.localXCm ?? defaultLocalX),
        localYCm: pickNumber([local, slot3d], ['y', 'localYCm', 'localY'], existingSlot?.localYCm ?? defaultLocalY),
        localZCm: pickNumber([local, slot3d], ['z', 'localZCm', 'localZ'], existingSlot?.localZCm ?? 0),
        widthCm: pickNumber([size, slot3d], ['width', 'widthCm'], existingSlot?.widthCm ?? DEFAULT_SLOT_CM.width, true),
        heightCm: pickNumber([size, slot3d], ['height', 'heightCm'], existingSlot?.heightCm ?? DEFAULT_SLOT_CM.height, true),
        depthCm: pickNumber([size, slot3d], ['depth', 'depthCm'], existingSlot?.depthCm ?? DEFAULT_SLOT_CM.depth, true),
        status: 'empty',
        data: { ...recordOf(existingSlot?.data), locationCode: location.code },
        updatedAt: now,
      };
      slotRows.push(row);
      slotByIdentity.set(`${location.wh}\0${location.zone}\0${location.rack}\0${location.shelf}\0${location.slot}`, row.id);
    }
  }

  const slotIds = new Set(slotRows.map((slot) => slot.id));
  const occupied = new Set<string>();
  const boxesByTag = new Map<string, BoxGeometryValues>();
  for (const [tag, value] of Object.entries(boxMap)) {
    const box = recordOf(value);
    const location = recordOf(box.location);
    const status = text(box.status) || 'pending';
    let slotId = text(box.slotId) || text(location.code);
    if (!slotIds.has(slotId)) {
      slotId = slotByIdentity.get([
        text(location.wh), text(location.zone), text(location.rack),
        text(location.shelf) || '1', text(location.slot) || '1',
      ].join('\0')) ?? '';
    }
    if (!['warehouse', 'hold', 'damage'].includes(status) || !slotIds.has(slotId)) slotId = '';
    if (slotId) occupied.add(slotId);
    const boxType = recordOf(boxTypeMap[text(box.type)]);
    boxesByTag.set(tag, boxGeometryValues(box, boxType, slotId || null));
  }

  for (const slot of slotRows) slot.status = occupied.has(slot.id) ? 'full' : 'empty';
  return { rackRows, slotRows, boxesByTag };
}

export type BoxGeometrySelect = Pick<typeof boxes.$inferSelect, 'tag' | 'slotId' | 'widthCm' | 'heightCm' | 'depthCm' | 'materialType'>;
