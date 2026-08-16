import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { getDb } from '../db/client.js';
import { uiPrefs } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Per-account UI state for the legacy single-page app (uiPrefGet/uiPrefSet in
 * legacy.html): which tab the account was last on, which record/sub-view it
 * had open there, and the smaller per-account view settings (theme, layout,
 * list mode, remembered filter values).
 *
 * These used to sit in S.uiPrefs and ride along on PUT /api/state, but
 * stateSchema never declared a `uiPrefs` key — Zod dropped it on every save,
 * so nothing was ever actually persisted. Same class of bug, and same fix, as
 * gate_prefs: a small per-account table with its own endpoint, kept out of the
 * shared `S` snapshot that all clients receive and would stomp on.
 *
 * PUT is a MERGE, not a replace. The UI saves one key at a time as the person
 * navigates, and two tabs open on the same account must not erase each other's
 * unrelated keys — last writer wins per key, not per document.
 */
export const uiPrefsRouter = Router();

uiPrefsRouter.use(requireAuth);

uiPrefsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [row] = await db.select().from(uiPrefs).where(eq(uiPrefs.username, req.user!.username));
    res.json((row?.data as Record<string, unknown>) ?? {});
  }),
);

uiPrefsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    /* Client-owned free-form view settings, so the shape is deliberately not
       enumerated here — but it still has to be a plain JSON object (an array or
       scalar would break the merge below) and stay small enough that this can
       never become a general-purpose blob store on the account row. */
    const body: unknown = req.body;
    const patch =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const db = getDb();
    const username = req.user!.username;

    const [row] = await db.select().from(uiPrefs).where(eq(uiPrefs.username, username));
    const merged = { ...((row?.data as Record<string, unknown>) ?? {}), ...patch };

    await db
      .insert(uiPrefs)
      .values({ username, data: merged, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: uiPrefs.username,
        set: { data: merged, updatedAt: new Date() },
      });
    res.json({ ok: true });
  }),
);

export default uiPrefsRouter;
