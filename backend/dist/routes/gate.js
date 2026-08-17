import { Router } from 'express';
import { getDb } from '../db/client.js';
import { gateOut, gateIn } from '../services/gate.js';
import { gateOutSchema, gateInSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { bump } from '../lib/bus.js';
/** Server-side gate operations for physical readers / integrations. */
export const gateRouter = Router();
gateRouter.use(requireAuth);
/* Out is a borrow, in is a return — a role may be trusted with one and not
   the other (a receiving-only station, say), so they are checked separately
   rather than behind one blanket "may use the gate". */
const canBorrow = requirePermission('borrow.create');
const canReturn = requirePermission('return.create');
/**
 * The terminal that sent the scan, from its own bearer token — a handheld
 * signs in as a per-device service account, so this pins every movement to a
 * physical reader alongside the operator's employee id. Not client-supplied:
 * it can only be whatever account the token was actually issued to.
 */
const deviceOf = (req) => req.user?.username ?? '';
gateRouter.post('/out', canBorrow, asyncHandler(async (req, res) => {
    const input = gateOutSchema.parse(req.body);
    const result = await gateOut(getDb(), { ...input, device: deviceOf(req) });
    /* A handheld scan has to reach the dashboards too, and it never goes
       through PUT /api/state — so the notification belongs here as well. */
    bump(req.get('X-Client-Id'));
    res.json(result);
}));
gateRouter.post('/in', canReturn, asyncHandler(async (req, res) => {
    const input = gateInSchema.parse(req.body);
    const result = await gateIn(getDb(), { ...input, device: deviceOf(req) });
    /* A handheld scan has to reach the dashboards too, and it never goes
       through PUT /api/state — so the notification belongs here as well. */
    bump(req.get('X-Client-Id'));
    res.json(result);
}));
export default gateRouter;
//# sourceMappingURL=gate.js.map