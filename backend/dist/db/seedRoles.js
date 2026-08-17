/**
 * Ensures the built-in roles exist and that Super Admin holds every permission.
 *
 * Called from both migrate.ts and seed.ts (and by the tests) because a database
 * with no roles at all is not a working system: every RBAC check would resolve
 * to "no permissions" and lock out even the admin account. Idempotent by design
 * — an admin who renamed or re-scoped a seeded role keeps their edits; only the
 * rows that are missing get created.
 *
 * Super Admin is the deliberate exception: its permission grants are re-synced
 * to the full catalog on every boot, so a permission added in a later release
 * is never missing from the one role that is supposed to have all of them.
 */
import { eq, inArray } from 'drizzle-orm';
import { getDb } from './client.js';
import { roles, rolePermissions, users } from './schema.js';
import { ALL_PERMISSIONS, SEED_ROLES, SUPER_ADMIN_KEY, roleKeyForLegacy, } from '../lib/permissions.js';
export async function seedRoles() {
    const db = getDb();
    for (const seed of SEED_ROLES) {
        const existing = await db.select().from(roles).where(eq(roles.key, seed.key));
        if (!existing.length) {
            const [row] = await db
                .insert(roles)
                .values({
                key: seed.key,
                name: seed.name,
                description: seed.description,
                active: true,
                system: seed.system ?? false,
            })
                .returning();
            if (seed.permissions.length) {
                await db
                    .insert(rolePermissions)
                    .values(seed.permissions.map((permission) => ({ roleId: row.id, permission })))
                    .onConflictDoNothing();
            }
        }
        else if (seed.key === SUPER_ADMIN_KEY) {
            /* Re-sync only Super Admin, and only additively: a release that adds a
               permission must not leave the all-powerful role short of it. */
            await db
                .insert(rolePermissions)
                .values(ALL_PERMISSIONS.map((permission) => ({ roleId: existing[0].id, permission })))
                .onConflictDoNothing();
            if (!existing[0].system || !existing[0].active) {
                await db
                    .update(roles)
                    .set({ system: true, active: true })
                    .where(eq(roles.id, existing[0].id));
            }
        }
    }
    await backfillUserRoles();
}
/** Points accounts that predate RBAC at the seeded role their legacy
 *  `users.role` string implies, so nobody is left with a null role_id. */
async function backfillUserRoles() {
    const db = getDb();
    const rows = await db.select().from(users);
    const pending = rows.filter((u) => u.roleId == null);
    if (!pending.length)
        return;
    const keys = [...new Set(pending.map((u) => roleKeyForLegacy(u.role)))];
    const roleRows = await db.select().from(roles).where(inArray(roles.key, keys));
    const byKey = new Map(roleRows.map((r) => [r.key, r.id]));
    for (const u of pending) {
        const roleId = byKey.get(roleKeyForLegacy(u.role));
        if (roleId != null)
            await db.update(users).set({ roleId }).where(eq(users.id, u.id));
    }
}
//# sourceMappingURL=seedRoles.js.map