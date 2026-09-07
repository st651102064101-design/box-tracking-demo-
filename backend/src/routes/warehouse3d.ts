import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { boxes, racks, slots, warehouses } from '../db/schema.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { writeAuditLog } from '../services/audit.js';
import { bump } from '../lib/bus.js';

const centimetres = z.number().finite().positive().max(1_000_000);
const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const materialType = z.string().trim().min(1).max(80);

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

const rackJson = (rack: typeof racks.$inferSelect, rackSlots: typeof slots.$inferSelect[]) => ({
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
    /* Occupancy and "reported full" are different facts. A box in a slot must
       not turn the 3D slot red; only an explicit PDA/web full report does. */
    const reportedFull = typeof data.reportedFullAt === 'string' && data.reportedFullAt.trim() !== '';
    return {
      id: slot.id,
      // The Location Master code is the barcode printed and scanned on a slot.
      barcode: String(data.barcode ?? data.locationCode ?? slot.id),
      shelfCode: slot.shelfCode,
      slotCode: slot.slotCode,
      localPositionCm: { x: slot.localXCm, y: slot.localYCm, z: slot.localZCm },
      dimensionsCm: { width: slot.widthCm, height: slot.heightCm, depth: slot.depthCm },
      status: reportedFull ? 'full' : 'empty',
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
        widthCm: boxes.widthCm,
        heightCm: boxes.heightCm,
        depthCm: boxes.depthCm,
        materialType: boxes.materialType,
      }).from(boxes).where(inArray(boxes.slotId, slotIds))
      : [];
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
      doors,
      racks: rackRows.map((rack) => rackJson(rack, slotsByRack.get(rack.id) ?? [])),
      boxes: boxRows.map((box) => ({
        id: box.tag,
        slotId: box.slotId,
        status: box.status,
        dimensionsCm: { width: box.widthCm, height: box.heightCm, depth: box.depthCm },
        materialType: box.materialType,
      })),
      stats: { racks: rackRows.length, slots: slotRows.length, boxes: boxRows.length },
    });
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
