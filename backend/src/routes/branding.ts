import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { config } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import { SUPER_ADMIN_KEY } from '../lib/permissions.js';
import { bump } from '../lib/bus.js';

export const brandingRouter = Router();

const DEFAULT_BRANDING = {
  systemName: 'Smart Tracking',
  subtitle: 'WMS · เฟส 1 · Returnable Asset Tracking',
  logoData: null as string | null,
};

const brandingSchema = z.object({
  systemName: z.string().trim().min(1).max(80),
  subtitle: z.string().trim().max(180).default(''),
  logoData: z.string().max(3_000_000).nullable().optional(),
});

/** Public because the login/onboarding shell needs branding before auth. */
brandingRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(config).where(eq(config.id, 1));
    const row = rows[0];
    res.json(row ? {
      systemName: row.systemName,
      subtitle: row.subtitle,
      logoData: row.logoData,
    } : DEFAULT_BRANDING);
  }),
);

/** Public binary logo for the browser favicon.  The tab requests this before
 * client JavaScript is running, so it must come from the DB here rather than
 * relying on the default SVG in the HTML shell. */
brandingRouter.get(
  '/favicon',
  asyncHandler(async (_req, res) => {
    const rows = await getDb().select().from(config).where(eq(config.id, 1));
    const logoData = rows[0]?.logoData;
    const match = logoData?.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!match) {
      res.status(204).end();
      return;
    }
    res.set('Cache-Control', 'no-store, max-age=0');
    res.type(match[1]);
    res.send(Buffer.from(match[2], 'base64'));
  }),
);

brandingRouter.put(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const effective = await effectivePermissions(req.user);
    if (effective.key !== SUPER_ADMIN_KEY) {
      throw httpError(403, 'เฉพาะผู้ดูแลระบบสูงสุดเท่านั้นที่แก้ไขชื่อระบบและโลโก้ได้', 'forbidden');
    }
    const input = brandingSchema.parse(req.body);
    const values = {
      systemName: input.systemName,
      subtitle: input.subtitle,
      logoData: input.logoData ?? null,
      updatedAt: new Date(),
    };
    await getDb().insert(config).values({ id: 1, ...values }).onConflictDoUpdate({
      target: config.id,
      set: values,
    });
    bump(req.get('X-Client-Id'));
    res.json({ systemName: values.systemName, subtitle: values.subtitle, logoData: values.logoData });
  }),
);

export default brandingRouter;
