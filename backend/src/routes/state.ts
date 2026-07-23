import { Router } from 'express';
import { getDb } from '../db/client.js';
import { composeState, replaceState } from '../services/state.js';
import { stateSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * The persistence bridge used by the legacy single-page UI.
 *   GET /api/state → the full `S` snapshot (what localStorage used to hold)
 *   PUT /api/state → replace the stored state wholesale (what `save()` did)
 */
export const stateRouter = Router();

stateRouter.use(requireAuth);

stateRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const state = await composeState(db);
    res.json(state);
  }),
);

stateRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const payload = stateSchema.parse(req.body);
    const db = getDb();
    await replaceState(db, payload);
    res.json({ ok: true });
  }),
);

export default stateRouter;
