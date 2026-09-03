/**
 * Resolves what a signed-in caller is actually allowed to do.
 *
 * Deliberately resolved from the DB per request rather than baked into the JWT:
 * revoking a permission has to take effect on the next request, not whenever
 * the token happens to expire (up to 2h later, per JWT_EXPIRES_IN). A short
 * in-process cache keeps that from turning into two extra queries per call —
 * ROLE_TTL_MS is the worst-case lag between an admin saving a role and it
 * biting, which is a couple of seconds, not hours.
 */
import { eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { roles, rolePermissions, users, employees } from '../db/schema.js';
import { roleKeyForLegacy } from './permissions.js';
import type { JwtPayload } from './jwt.js';

const ROLE_TTL_MS = 5_000;

interface CachedRole {
  id: number;
  key: string;
  name: string;
  description: string;
  active: boolean;
  system: boolean;
  permissions: Set<string>;
}

let cache: { at: number; byId: Map<number, CachedRole>; byKey: Map<string, CachedRole> } | null =
  null;

async function loadRoles() {
  if (cache && Date.now() - cache.at < ROLE_TTL_MS) return cache;
  const db = getDb();
  /* A soft-deleted role must grant nothing, ever again — same invariant as
     roles.ts's own list/lookup endpoints. Excluding it here (not just from the
     admin UI) is what actually enforces that for any account still pointing
     at it. */
  const roleRows = await db.select().from(roles).where(isNull(roles.deletedAt));
  const permRows = roleRows.length
    ? await db
        .select()
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, roleRows.map((r) => r.id)))
    : [];
  const byId = new Map<number, CachedRole>();
  const byKey = new Map<string, CachedRole>();
  for (const r of roleRows) {
    const entry: CachedRole = {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      active: r.active,
      system: r.system,
      permissions: new Set<string>(),
    };
    byId.set(r.id, entry);
    byKey.set(r.key, entry);
  }
  for (const p of permRows) byId.get(p.roleId)?.permissions.add(p.permission);
  cache = { at: Date.now(), byId, byKey };
  return cache;
}

/** Call after any write to roles/role_permissions so the next request sees it. */
export function invalidateRoleCache(): void {
  cache = null;
}

export interface EffectiveRole {
  roleId: number | null;
  key: string | null;
  name: string | null;
  description: string | null;
  /** false when the role exists but an admin switched it off — a disabled role
   *  grants nothing, which is the whole point of the toggle. */
  active: boolean;
  permissions: string[];
}

const NONE: EffectiveRole = {
  roleId: null,
  key: null,
  name: null,
  description: null,
  active: false,
  permissions: [],
};

/**
 * The caller's role + permission list. Accounts with no `role_id` (created
 * before RBAC, or an employee login) fall back to the role their legacy role
 * string maps to, so nobody is stranded with zero permissions after upgrading.
 */
export async function effectivePermissions(user: JwtPayload | undefined): Promise<EffectiveRole> {
  if (!user) return NONE;
  const { byId, byKey } = await loadRoles();
  const db = getDb();

  let roleId: number | null = null;
  if (user.employeeId) {
    /* An employee's own role wins over the one on any linked `users` row.
       Employees are the common case and most have no linked account at all,
       which is why the role lives on the employee record itself; the linked
       account is only consulted for employees created back when going through
       `users` was the only way to have one. */
    const rows = await db.select().from(employees).where(eq(employees.id, String(user.sub)));
    roleId = rows[0]?.roleId ?? null;
    const linkedUserId = rows[0]?.userId ?? null;
    if (roleId == null && linkedUserId != null) {
      const u = await db.select().from(users).where(eq(users.id, linkedUserId));
      roleId = u[0]?.roleId ?? null;
    }
  } else if (typeof user.sub === 'number' || /^\d+$/.test(String(user.sub))) {
    const u = await db.select().from(users).where(eq(users.id, Number(user.sub)));
    roleId = u[0]?.roleId ?? null;
  }

  const role = roleId != null ? byId.get(roleId) : byKey.get(roleKeyForLegacy(user.role));
  if (!role) return NONE;
  return {
    roleId: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    active: role.active,
    permissions: role.active ? [...role.permissions] : [],
  };
}
