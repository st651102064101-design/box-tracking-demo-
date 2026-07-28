import { Router } from 'express';
import { getDb } from '../db/client.js';
import { gateOut, gateIn } from '../services/gate.js';
import { gateOutSchema, gateInSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

/** Server-side gate operations for physical readers / integrations. */
export const gateRouter = Router();
gateRouter.use(requireAuth);

/**
 * The terminal that sent the scan, from its own bearer token — a handheld
 * signs in as a per-device service account, so this pins every movement to a
 * physical reader alongside the operator's employee id. Not client-supplied:
 * it can only be whatever account the token was actually issued to.
 */
const deviceOf = (req: { user?: { username: string } }) => req.user?.username ?? '';

gateRouter.post(
  '/out',
  asyncHandler(async (req, res) => {
    const input = gateOutSchema.parse(req.body);
    const result = await gateOut(getDb(), { ...input, device: deviceOf(req) });
    res.json(result);
  }),
);

gateRouter.post(
  '/in',
  asyncHandler(async (req, res) => {
    const input = gateInSchema.parse(req.body);
    const result = await gateIn(getDb(), { ...input, device: deviceOf(req) });
    res.json(result);
  }),
);

export default gateRouter;
