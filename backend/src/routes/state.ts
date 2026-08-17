import { Router } from 'express';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import { composeState, replaceState } from '../services/state.js';
import { stateSchema } from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';
import { guardStatePayload } from '../services/stateGuard.js';
import { bump } from '../lib/bus.js';

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
  requireRole('admin', 'staff'),
  asyncHandler(async (req, res) => {
    const payload = stateSchema.parse(req.body);
    const db = getDb();

    /* Guard against privilege escalation: the legacy UI's own admin-only check
       (isAdmin() in legacy.html) is client-side only, and this endpoint accepts
       the whole `S` snapshot verbatim. A non-admin caller must not be able to
       grant/change any employee's access level (including their own) by simply
       PUTting a modified state. */
    if (req.user?.role !== 'admin') {
      const current = await db.select().from(employees);
      const currentAccess = new Map(
        current.map((e) => [e.id, (e.data as Record<string, unknown> | null)?.access]),
      );
      for (const [id, raw] of Object.entries(payload.employees ?? {})) {
        const incomingAccess = (raw as Record<string, unknown>)?.access;
        if (incomingAccess !== currentAccess.get(id)) {
          throw httpError(403, 'คุณไม่มีสิทธิ์เปลี่ยนสิทธิ์การใช้งานพนักงาน', 'forbidden');
        }
      }
    }

    /* Design decision: no one — not even an admin — may delete their own employee
       record through this endpoint. The client (legacy.html) already blocks this
       in the UI, but this endpoint accepts a raw state snapshot, so the real gate
       has to live here: reject any upload that drops the caller's own employeeId. */
    if (req.user?.employeeId && !(req.user.employeeId in (payload.employees ?? {}))) {
      throw httpError(403, 'ไม่สามารถลบบัญชีของตัวเองได้', 'forbidden');
    }

    /* RBAC, applied as a diff. This endpoint takes the entire `S` object, so
       the only way to ask "what is this request actually changing?" is to
       compare it with what is stored. Groups the caller may not change are
       reverted to the stored version rather than 403-ing the whole upload —
       every snapshot carries every table, so an outright rejection would stop
       an operator from saving the one box they are allowed to edit.
       See services/stateGuard.ts for the group→permission map. */
    const { permissions } = await effectivePermissions(req.user);
    const stored = await composeState(db);
    const { payload: allowed, rejected } = guardStatePayload(
      payload,
      stored as unknown as Record<string, unknown>,
      permissions,
    );

    await replaceState(db, allowed, req.user);
    /* Tell every open stream. The writer's own id rides along so its browser
       can skip re-fetching the snapshot it just uploaded. */
    const version = bump(req.get('X-Client-Id'));
    /* 200 with a report, not an error: the allowed part of the save did happen.
       The UI tells the user which parts didn't and reloads so the screen stops
       showing edits the server refused. */
    res.json({ ok: true, version, rejected });
  }),
);

export default stateRouter;
