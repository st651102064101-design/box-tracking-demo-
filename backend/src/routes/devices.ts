import { Router } from 'express';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { devicePresence } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { requirePermissions } from './roles.js';

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

const heartbeatSchema = z.object({
  /** Friendly, detected name only. The row identity comes from the JWT. */
  name: z.string().trim().min(1).max(120),
  model: z.string().trim().max(80).optional(),
  ipAddress: z.string().trim().max(64).optional(),
  warehouseId: z.string().trim().max(80).optional(),
  gateNo: z.number().int().positive().max(9999).optional(),
});

const ONLINE_MS = 75_000;

function view(row: typeof devicePresence.$inferSelect) {
  const seen = row.lastSeenAt?.getTime() ?? 0;
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    ipAddress: row.ipAddress,
    warehouse: row.warehouseId,
    gate: row.gateNo,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    online: Date.now() - seen <= ONLINE_MS,
  };
}

/** A PDA calls this after it has authenticated. The service account is the
 * stable identity. The IP is the handheld's own LAN address, reported so the
 * dashboard can show which terminal is which. */
devicesRouter.post(
  '/heartbeat',
  requirePermissions('device.manage'),
  asyncHandler(async (req, res) => {
    const input = heartbeatSchema.parse(req.body);
    const now = new Date();
    const id = req.user!.username;
    const db = getDb();
    const [row] = await db
      .insert(devicePresence)
      .values({
        id,
        name: input.name,
        model: input.model || null,
        ipAddress: input.ipAddress || null,
        warehouseId: input.warehouseId || null,
        gateNo: input.gateNo ?? null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: devicePresence.id,
        set: {
          name: input.name,
          model: input.model || null,
          ipAddress: input.ipAddress || null,
          warehouseId: input.warehouseId || null,
          gateNo: input.gateNo ?? null,
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .returning();
    res.json({ device: view(row) });
  }),
);

/** The dashboard only needs the latest fact per provisioned handheld. */
devicesRouter.get(
  '/',
  requirePermissions('device.manage', 'setting.view'),
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(devicePresence).orderBy(desc(devicePresence.lastSeenAt));
    res.json({ devices: rows.map(view), onlineThresholdSeconds: ONLINE_MS / 1000 });
  }),
);

export default devicesRouter;
