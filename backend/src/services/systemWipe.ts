/**
 * ============================================================================
 * Full System Wipe
 * ----------------------------------------------------------------------------
 * "Reset to factory state, keep the Super Admin(s) who can still get back in."
 *
 * Protected identity: NOT a hardcoded id like "EMP-001" — that string is a
 * purely client-side display convention (see legacy.html's nextSeqId(), which
 * assigns "EMP-" + (max existing number + 1) at creation time) with zero
 * special meaning in this schema. The actual invariant this wipe preserves is
 * role-based: every employee currently holding the `super_admin` role (see
 * superAdminGuard.ts / permissions.ts SUPER_ADMIN_KEY) survives, under
 * whatever id they already have — their profile is reset to a bootstrap-like
 * default, but their identity (id), login (username/passwordHash/pinHash) and
 * role assignment are left untouched so they can still sign in immediately
 * after the wipe.
 *
 * The `users` table (system/service accounts — what SEED_ADMIN_USERNAME
 * creates) is never touched here at all: it isn't "operational data produced
 * by using the app", it's the installation's own login, and wiping/resetting
 * it is not something this feature was asked to do.
 * ============================================================================
 */
import { eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  boxes,
  customers,
  boxTypes,
  warehouses,
  gates,
  gateWebhookStatus,
  gatePendingReads,
  gatePrefs,
  uiPrefs,
  locations,
  employees,
  vehicles,
  doRecords,
  putaway,
  inventory,
  cycleCounts,
  events,
  auditLog,
  config,
  sequences,
  roles,
} from '../db/schema.js';
import { SUPER_ADMIN_KEY } from '../lib/permissions.js';

/* Same advisory lock PUT /api/state takes (see services/state.ts) — serializes
   the wipe against any concurrent whole-state save from a still-open client
   tab, so a save landing mid-wipe can't resurrect rows the wipe just deleted
   (or the wipe can't delete rows a save is mid-way through writing). */
const STATE_WRITE_LOCK = 4711_0001;

export interface WipeResult {
  /** Employee ids that held super_admin and were kept (profile reset, not deleted). */
  keptEmployeeIds: string[];
}

/** Bootstrap-like default profile for a kept Super Admin employee. `access:
 *  'admin'` is preserved deliberately: routes/auth.ts derives the *coarse*
 *  legacy `role` JWT claim (used by requireRole()) from `data.access`, not
 *  from roleId — an empty `data` would silently downgrade this employee's
 *  token-level role even though roleId still points at super_admin. */
const RESET_EMPLOYEE_DATA = { access: 'admin' };
const RESET_EMPLOYEE_NAME = 'Super Admin';

/**
 * Deletes all operational data and every employee except active
 * super_admin holders, whose profile is reset in place. Runs in one
 * transaction: any failure rolls back the whole thing, never a half-wiped
 * system.
 */
export async function wipeSystem(db: DB): Promise<WipeResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${STATE_WRITE_LOCK})`);

    const [superAdminRole] = await tx.select().from(roles).where(eq(roles.key, SUPER_ADMIN_KEY));
    if (!superAdminRole) {
      throw new Error('super_admin role is missing — has the schema been seeded?');
    }

    const holders = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.roleId, superAdminRole.id));
    const keepIds = holders.map((h) => h.id);

    /* ── operational data: no FK anywhere in this schema points AT these
       tables (see schema.sql — the only real FKs are employees/users → roles
       and employees → users), so order among them doesn't matter. ────────── */
    await tx.delete(boxes);
    await tx.delete(customers);
    await tx.delete(boxTypes);
    await tx.delete(warehouses);
    await tx.delete(gates);
    await tx.delete(gateWebhookStatus);
    await tx.delete(gatePendingReads);
    await tx.delete(gatePrefs);
    await tx.delete(uiPrefs);
    await tx.delete(locations);
    await tx.delete(vehicles);
    await tx.delete(doRecords);
    await tx.delete(putaway);
    await tx.delete(inventory);
    await tx.delete(cycleCounts);
    await tx.delete(events);
    /* audit_log is append-only everywhere else in this codebase (see
       services/state.ts's comment on replaceState) — a Full Wipe is the one
       deliberate exception: it *is* the "start a clean audit trail" action,
       and the wipe itself gets written back into it right after (see the
       route handler, outside this transaction). */
    await tx.delete(auditLog);

    /* ── employees: delete everyone except active super_admin holders; reset
       the holders' profile in place rather than delete-then-reinsert, so
       their id (and anything an id-based reference elsewhere might carry)
       never changes. ──────────────────────────────────────────────────── */
    if (keepIds.length) {
      await tx.delete(employees).where(notInArray(employees.id, keepIds));
      await tx
        .update(employees)
        .set({ name: RESET_EMPLOYEE_NAME, data: RESET_EMPLOYEE_DATA, updatedAt: new Date() })
        .where(inArray(employees.id, keepIds));
    } else {
      await tx.delete(employees);
    }

    /* config: reset to defaults, not deleted — id=1 is a singleton every
       composeState() read assumes exists. */
    await tx
      .insert(config)
      .values({ id: 1, agingDays: 15, boxValue: '450', lostMode: 'manual', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: config.id,
        set: { agingDays: 15, boxValue: '450', lostMode: 'manual', updatedAt: new Date() },
      });

    /* sequences: 'do' back to 0. 'emp' is set to the highest "EMP-nnn" number
       among KEPT employees (0 if none) rather than blindly to 0, so the next
       employee created doesn't collide with an id that's still in use — this
       mirrors the same max-based approach legacy.html's own nextSeqId()
       already uses, just computed server-side at wipe time instead of
       client-side at create time. It does not by itself make employee-id
       assignment concurrency-safe across two simultaneous browser tabs; that
       would need a real atomic "next id" endpoint, which nothing in this
       codebase has today and is out of scope for a wipe. */
    const maxKeptEmpNum = keepIds.reduce((max, id) => {
      const m = /^EMP-(\d+)$/.exec(id);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    await tx.delete(sequences);
    await tx.insert(sequences).values([
      { name: 'do', value: 0 },
      { name: 'emp', value: maxKeptEmpNum },
    ]);

    return { keptEmployeeIds: keepIds };
  });
}
