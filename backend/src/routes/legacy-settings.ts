import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { appSettings, customers } from '../db/schema.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const legacySettingsRouter = Router();
const plainObject = z.record(z.unknown());

async function read(key: string): Promise<Record<string, unknown>> {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row && row.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? (row.data as Record<string, unknown>)
    : {};
}
async function merge(key: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = { ...(await read(key)), ...patch };
  await getDb().insert(appSettings).values({ key, data }).onConflictDoUpdate({
    target: appSettings.key,
    set: { data, updatedAt: new Date() },
  });
  return data;
}

/* Branding is intentionally readable before sign-in: it supplies the login
 * screen title and favicon. All account-specific preferences remain protected. */
legacySettingsRouter.get('/branding', asyncHandler(async (_req, res) => res.json(await read('branding'))));
legacySettingsRouter.get('/branding/fx9600-reader-image', asyncHandler(async (_req, res) => {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.key, 'branding:fx9600-reader-image')).limit(1);
  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  if (data.mimeType !== 'image/png' || typeof data.base64 !== 'string' || !data.base64) {
    res.status(404).json({ error: 'fx9600_reader_image_not_found' });
    return;
  }
  res.type('image/png').set('Cache-Control', 'public, max-age=300').send(Buffer.from(data.base64, 'base64'));
}));
legacySettingsRouter.get('/branding/favicon', asyncHandler(async (_req, res) => {
  res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111"/><path d="M9 8h14v16H9z" fill="none" stroke="#a3ff12" stroke-width="2"/><path d="M13 13h6M13 18h6" stroke="#fff" stroke-width="2"/></svg>');
}));
legacySettingsRouter.put('/branding', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  res.json(await merge('branding', plainObject.parse(req.body)));
}));

legacySettingsRouter.get('/ui-prefs', requireAuth, asyncHandler(async (req, res) => {
  res.json(await read(`ui:${req.user!.username}`));
}));
legacySettingsRouter.put('/ui-prefs', requireAuth, asyncHandler(async (req, res) => {
  res.json(await merge(`ui:${req.user!.username}`, plainObject.parse(req.body)));
}));

legacySettingsRouter.get('/gate-prefs', requireAuth, asyncHandler(async (req, res) => {
  const data = await read(`gate:${req.user!.username}`);
  res.json({ out: typeof data.out === 'string' ? data.out : '', in: typeof data.in === 'string' ? data.in : '' });
}));

/* The legacy dashboard refreshes customer LINE badges periodically. Read the
 * profile already saved with the customer master instead of returning 404
 * when no separate LINE-link service is configured. Never expose the LINE
 * Messaging User ID itself through this status endpoint. */
legacySettingsRouter.get('/line/link/customers/:customerId/profile', requireAuth, asyncHandler(async (req, res) => {
  const [row] = await getDb().select().from(customers).where(eq(customers.id, req.params.customerId)).limit(1);
  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  const userId = typeof data.lineUserId === 'string' ? data.lineUserId : '';
  res.json({
    linked: data.lineLinked === true || /^U[0-9a-f]{32}$/i.test(userId),
    displayName: typeof data.lineDisplayName === 'string' ? data.lineDisplayName : '',
    pictureUrl: typeof data.linePictureUrl === 'string' ? data.linePictureUrl : '',
    linkedAt: typeof data.lineLinkedAt === 'string' ? data.lineLinkedAt : '',
  });
}));
legacySettingsRouter.put('/gate-prefs', requireAuth, asyncHandler(async (req, res) => {
  const input = z.object({ out: z.string().optional(), in: z.string().optional() }).parse(req.body);
  const data = await merge(`gate:${req.user!.username}`, input);
  res.json({ out: typeof data.out === 'string' ? data.out : '', in: typeof data.in === 'string' ? data.in : '' });
}));

/* 3D layout is an optional enhancement. An empty document keeps the regular
 * warehouse page usable on installations where no 3D layout was configured. */
legacySettingsRouter.get('/warehouse-3d', requireAuth, (_req, res) => res.json({}));

export default legacySettingsRouter;
