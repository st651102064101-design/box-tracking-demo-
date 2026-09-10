import { Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { boxes, boxTypes, racks, slots, warehouses } from '../db/schema.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

const centimetres = z.number().finite().positive().max(1_000_000);
const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const materialType = z.string().trim().min(1).max(80);
const forkliftPositionSchema = z.object({
  warehouseId: z.string().trim().min(1),
  position: z.object({ x: coordinate, y: coordinate, z: coordinate }),
  rotationY: z.number().finite().optional(),
  target: z.object({ x: coordinate, y: coordinate, z: coordinate }).nullable().optional(),
});

const rackGeometrySchema = z.object({
  positionCm: z.object({ x: coordinate, y: coordinate, z: coordinate }).partial().optional(),
  rotationYDeg: z.number().finite().min(-360_000).max(360_000).optional(),
  dimensionsCm: z.object({ width: centimetres, height: centimetres, depth: centimetres }).partial().optional(),
  materialType: materialType.optional(),
}).refine((value) => Object.keys(value).length > 0, 'ต้องมีข้อมูลที่ต้องการแก้ไข');

const slotGeometrySchema = z.object({
  localPositionCm: z.object({ x: coordinate, y: coordinate, z: coordinate }).partial().optional(),
  dimensionsCm: z.object({ width: centimetres, height: centimetres, depth: centimetres }).partial().optional(),
}).refine((value) => Object.keys(value).length > 0, 'ต้องมีข้อมูลที่ต้องการแก้ไข');

const SLOT_CAPACITY = 2;

const parseBoxTypeDimensions = (value: string | null) => {
  if (!value) return null;
  const parts = value.trim().split(/\s*[xX×]\s*/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part <= 0)) return null;
  const [width, height, depth] = parts;
  return { width, height, depth };
};

const rackJson = (
  rack: typeof racks.$inferSelect,
  rackSlots: typeof slots.$inferSelect[],
  boxCountBySlot = new Map<string, number>(),
) => ({
  id: rack.id,
  warehouseId: rack.warehouseId,
  zone: rack.zone,
  code: rack.code,
  positionCm: { x: rack.positionXCm, y: rack.positionYCm, z: rack.positionZCm },
  rotationYDeg: rack.rotationYDeg,
  dimensionsCm: { width: rack.widthCm, height: rack.heightCm, depth: rack.depthCm },
  materialType: rack.materialType,
  slots: rackSlots.map((slot) => {
    const data = (slot.data ?? {}) as Record<string, unknown>;
    const boxCount = boxCountBySlot.get(slot.id) ?? 0;
    // Every selective-rack slot represents two pallet positions. A manual
    // full report remains authoritative, while two stored boxes/pallets also
    // make the slot full automatically for the 3D view.
    const reportedFull = typeof data.reportedFullAt === 'string' && data.reportedFullAt.trim() !== '';
    return {
      id: slot.id,
      // The Location Master code is the barcode printed and scanned on a slot.
      barcode: String(data.barcode ?? data.locationCode ?? slot.id),
      shelfCode: slot.shelfCode,
      slotCode: slot.slotCode,
      localPositionCm: { x: slot.localXCm, y: slot.localYCm, z: slot.localZCm },
      dimensionsCm: { width: slot.widthCm, height: slot.heightCm, depth: slot.depthCm },
      boxCount,
      capacity: SLOT_CAPACITY,
      status: reportedFull || boxCount >= SLOT_CAPACITY ? 'full' : 'empty',
    };
  }),
});

/**
 * Real-scale geometry API. PostgreSQL remains centimetre-based for operator
 * input and reports; clients multiply by `scaleToWorldUnit` exactly once when
 * constructing Three.js matrices (1 world unit = 1 metre).
 */
export const warehouse3dRouter = Router();
warehouse3dRouter.use(requireAuth);

warehouse3dRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const warehouseId = String(req.query.warehouseId ?? '').trim();
    const db = getDb();
    const [warehouse] = warehouseId
      ? await db.select().from(warehouses).where(eq(warehouses.id, warehouseId))
      : [];
    const rackRows = warehouseId
      ? await db.select().from(racks).where(eq(racks.warehouseId, warehouseId))
      : await db.select().from(racks);
    const rackIds = rackRows.map((rack) => rack.id);
    const slotRows = rackIds.length
      ? await db.select().from(slots).where(inArray(slots.rackId, rackIds))
      : [];
    const slotIds = slotRows.map((slot) => slot.id);
    const boxRows = slotIds.length
      ? await db.select({
        tag: boxes.tag,
        slotId: boxes.slotId,
        status: boxes.status,
        type: boxes.type,
        widthCm: boxes.widthCm,
        heightCm: boxes.heightCm,
        depthCm: boxes.depthCm,
        materialType: boxes.materialType,
        boxTypeName: boxTypes.name,
        boxTypeDimensions: boxTypes.dim,
      })
        .from(boxes)
        .leftJoin(boxTypes, eq(boxes.type, boxTypes.id))
        .where(and(inArray(boxes.slotId, slotIds), eq(boxes.status, 'warehouse')))
      : [];
    // A received box without a physical slot is waiting in the inbound staging
    // area. Keep it separate from shelf inventory: the 3D client renders one
    // selectable pallet position per box, so an operator never has to click
    // through a stack to choose the box a forklift should take next.
    const unstagedRows = warehouseId
      ? await db.select({
        tag: boxes.tag,
        status: boxes.status,
        labeled: boxes.labeled,
        location: boxes.location,
        type: boxes.type,
        widthCm: boxes.widthCm,
        heightCm: boxes.heightCm,
        depthCm: boxes.depthCm,
        materialType: boxes.materialType,
        boxTypeName: boxTypes.name,
        boxTypeDimensions: boxTypes.dim,
      })
        .from(boxes)
        .leftJoin(boxTypes, eq(boxes.type, boxTypes.id))
        .where(isNull(boxes.slotId))
      : [];
    const stagingBoxes = unstagedRows.filter((box) => {
      const location = (box.location ?? {}) as Record<string, unknown>;
      return location.wh === warehouseId
        && (box.status === 'warehouse' || (box.status === 'pending' && box.labeled))
        && (location.staging === true || (!location.shelf && !location.slot));
    });
    const boxCountBySlot = new Map<string, number>();
    boxRows.forEach((box) => {
      if (!box.slotId) return;
      boxCountBySlot.set(box.slotId, (boxCountBySlot.get(box.slotId) ?? 0) + 1);
    });
    // The warehouse master is the sole source for its physical door count.
    // Do not infer doors from operational gate rows: a warehouse with no
    // configured gates intentionally has no doors in the 3D elevation.
    const configuredGateNumbers = Array.isArray(warehouse?.gates)
      ? (warehouse.gates as unknown[]).map((gate) => Number(gate)).filter(Number.isFinite)
      : [];
    const gateTypes = warehouse?.gateTypes && typeof warehouse.gateTypes === 'object'
      ? warehouse.gateTypes as Record<string, unknown>
      : {};
    const doors = configuredGateNumbers.map((gateNo, index) => {
      const rawType = String(gateTypes[String(gateNo)] ?? 'both');
      return { gateNo, type: ['in', 'out', 'both'].includes(rawType) ? rawType : 'both', index };
    });

    const slotsByRack = new Map<string, typeof slots.$inferSelect[]>();
    for (const slot of slotRows) {
      const list = slotsByRack.get(slot.rackId) ?? [];
      list.push(slot);
      slotsByRack.set(slot.rackId, list);
    }
    for (const list of slotsByRack.values()) {
      list.sort((a, b) => a.shelfCode.localeCompare(b.shelfCode, undefined, { numeric: true })
        || a.slotCode.localeCompare(b.slotCode, undefined, { numeric: true }));
    }
    rackRows.sort((a, b) => a.zone.localeCompare(b.zone, undefined, { numeric: true })
      || a.code.localeCompare(b.code, undefined, { numeric: true }));

    res.json({
      schemaVersion: 1,
      sourceUnit: 'cm',
      worldUnit: 'm',
      scaleToWorldUnit: 0.01,
      warehouseId: warehouseId || null,
      warehouseName: warehouse?.name ?? warehouseId ?? null,
      forkliftPosition: warehouse?.data && typeof warehouse.data === 'object'
        ? (warehouse.data as Record<string, unknown>).forkliftPosition ?? null
        : null,
      doors,
      racks: rackRows.map((rack) => rackJson(rack, slotsByRack.get(rack.id) ?? [], boxCountBySlot)),
      boxes: boxRows.map((box) => {
        // A box type is the operator-managed product master and therefore the
        // authoritative physical size. Older box rows can still contain the
        // legacy 60x40x40 defaults, so only fall back to them when the type has
        // no valid WxHxD value.
        const typeDimensions = parseBoxTypeDimensions(box.boxTypeDimensions);
        return {
          id: box.tag,
          slotId: box.slotId,
          status: box.status,
          dimensionsCm: typeDimensions ?? {
            width: box.widthCm,
            height: box.heightCm,
            depth: box.depthCm,
          },
          materialType: box.materialType,
          boxTypeName: box.boxTypeName,
        };
      }),
      stagingBoxes: stagingBoxes.map((box) => {
        const typeDimensions = parseBoxTypeDimensions(box.boxTypeDimensions);
        return {
          id: box.tag,
          status: box.status,
          type: box.type,
          dimensionsCm: typeDimensions ?? { width: box.widthCm, height: box.heightCm, depth: box.depthCm },
          materialType: box.materialType,
          boxTypeName: box.boxTypeName,
        };
      }),
      stats: { racks: rackRows.length, slots: slotRows.length, boxes: boxRows.length, stagingBoxes: stagingBoxes.length },
    });
  }),
);

warehouse3dRouter.put(
  '/forklift',
  requirePermission('master.manage'),
  asyncHandler(async (req, res) => {
    const input = forkliftPositionSchema.parse(req.body);
    const db = getDb();
    const [before] = await db.select().from(warehouses).where(eq(warehouses.id, input.warehouseId));
    if (!before) throw httpError(404, 'ไม่พบคลัง', 'warehouse_not_found');
    const data = {
      ...(before.data as Record<string, unknown>),
      forkliftPosition: { position: input.position, rotationY: input.rotationY ?? 0, target: input.target ?? null, updatedAt: new Date().toISOString() },
    };
    await db.update(warehouses).set({ data, updatedAt: new Date() }).where(eq(warehouses.id, before.id));
    bump(req.get('X-Client-Id'));
    res.json({ ok: true, forkliftPosition: data.forkliftPosition });
  }),
);

warehouse3dRouter.put(
  '/racks/:id',
  requirePermission('master.manage'),
  asyncHandler(async (req, res) => {
    const input = rackGeometrySchema.parse(req.body);
    const db = getDb();
    const [before] = await db.select().from(racks).where(eq(racks.id, req.params.id));
    if (!before) throw httpError(404, 'ไม่พบแร็ก', 'rack_not_found');
    const dimensions = input.dimensionsCm ?? {};
    const position = input.positionCm ?? {};
    const next = {
      positionXCm: position.x ?? before.positionXCm,
      positionYCm: position.y ?? before.positionYCm,
      positionZCm: position.z ?? before.positionZCm,
      rotationYDeg: input.rotationYDeg ?? before.rotationYDeg,
      widthCm: dimensions.width ?? before.widthCm,
      heightCm: dimensions.height ?? before.heightCm,
      depthCm: dimensions.depth ?? before.depthCm,
      materialType: input.materialType ?? before.materialType,
      data: { ...(before.data as Record<string, unknown>), ...input },
      updatedAt: new Date(),
    };
    const [updated] = await db.update(racks).set(next).where(eq(racks.id, before.id)).returning();
    await writeAuditLog(db, {
      action: 'UPDATE_RACK_GEOMETRY',
      actor: req.user!.username,
      itemId: before.id,
      itemName: `${before.zone} / ${before.code}`,
      before: rackJson(before, []),
      after: rackJson(updated, []),
    });
    bump(req.get('X-Client-Id'));
    res.json(rackJson(updated, []));
  }),
);

warehouse3dRouter.put(
  '/slots/:id',
  requirePermission('master.manage'),
  asyncHandler(async (req, res) => {
    const input = slotGeometrySchema.parse(req.body);
    const db = getDb();
    const [before] = await db.select().from(slots).where(eq(slots.id, req.params.id));
    if (!before) throw httpError(404, 'ไม่พบช่องจัดเก็บ', 'slot_not_found');
    const dimensions = input.dimensionsCm ?? {};
    const position = input.localPositionCm ?? {};
    const next = {
      localXCm: position.x ?? before.localXCm,
      localYCm: position.y ?? before.localYCm,
      localZCm: position.z ?? before.localZCm,
      widthCm: dimensions.width ?? before.widthCm,
      heightCm: dimensions.height ?? before.heightCm,
      depthCm: dimensions.depth ?? before.depthCm,
      data: { ...(before.data as Record<string, unknown>), ...input },
      updatedAt: new Date(),
    };
    const [updated] = await db.update(slots).set(next).where(eq(slots.id, before.id)).returning();
    await writeAuditLog(db, {
      action: 'UPDATE_SLOT_GEOMETRY',
      actor: req.user!.username,
      itemId: before.id,
      itemName: before.id,
      before,
      after: updated,
    });
    bump(req.get('X-Client-Id'));
    res.json({
      id: updated.id,
      rackId: updated.rackId,
      shelfCode: updated.shelfCode,
      slotCode: updated.slotCode,
      localPositionCm: { x: updated.localXCm, y: updated.localYCm, z: updated.localZCm },
      dimensionsCm: { width: updated.widthCm, height: updated.heightCm, depth: updated.depthCm },
      status: updated.status,
    });
  }),
);

export default warehouse3dRouter;
