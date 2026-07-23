import { Router } from 'express';
import { getDb } from '../db/client.js';
import { gateOut, gateIn } from '../services/gate.js';
import { gateOutSchema, gateInSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

/** Server-side gate operations for physical readers / integrations. */
export const gateRouter = Router();
gateRouter.use(requireAuth);

gateRouter.post(
  '/out',
  asyncHandler(async (req, res) => {
    const input = gateOutSchema.parse(req.body);
    const result = await gateOut(getDb(), input);
    res.json(result);
  }),
);

gateRouter.post(
  '/in',
  asyncHandler(async (req, res) => {
    const input = gateInSchema.parse(req.body);
    const result = await gateIn(getDb(), input);
    res.json(result);
  }),
);

export default gateRouter;
