import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { getDb } from '../db/client.js';
import { gatePrefs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
/**
 * Which gate (out/in) the current account last picked at Gate ขาออก/ขาเข้า
 * (see pickGate()/fixedGatesRef() in legacy.html). Used to live in
 * S.gatePrefs and round-trip through PUT /api/state like the rest of the
 * legacy UI's state, but stateSchema never declared that key so it was
 * silently stripped on every save — the choice never actually reached the
 * database and was forgotten on the next reload or a different device.
 * Deliberately its own small table + endpoint instead of adding the field
 * to stateSchema: it's per-account UI preference, not shared application
 * data, so it doesn't belong in the one-big-snapshot S object other
 * clients/tabs would receive and could stomp on each other's picks for.
 */
export const gatePrefsRouter = Router();
gatePrefsRouter.use(requireAuth);
gatePrefsRouter.get('/', asyncHandler(async (req, res) => {
    const db = getDb();
    const [row] = await db.select().from(gatePrefs).where(eq(gatePrefs.username, req.user.username));
    res.json({ out: row?.outGate ?? '', in: row?.inGate ?? '' });
}));
gatePrefsRouter.put('/', asyncHandler(async (req, res) => {
    const out = typeof req.body?.out === 'string' ? req.body.out : undefined;
    const inGate = typeof req.body?.in === 'string' ? req.body.in : undefined;
    const db = getDb();
    const username = req.user.username;
    await db
        .insert(gatePrefs)
        .values({ username, outGate: out ?? '', inGate: inGate ?? '', updatedAt: new Date() })
        .onConflictDoUpdate({
        target: gatePrefs.username,
        // Only overwrite whichever of out/in was actually sent — pickGate()
        // updates one direction at a time, and a bare-string undefined
        // shouldn't clobber the other direction's already-saved value.
        set: {
            ...(out !== undefined ? { outGate: out } : {}),
            ...(inGate !== undefined ? { inGate } : {}),
            updatedAt: new Date(),
        },
    });
    res.json({ ok: true });
}));
export default gatePrefsRouter;
//# sourceMappingURL=gatePrefs.js.map