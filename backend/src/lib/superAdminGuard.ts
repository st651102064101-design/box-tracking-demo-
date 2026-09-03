/**
 * ============================================================================
 * Last-Super-Admin protection
 * ----------------------------------------------------------------------------
 * Shared by routes/roles.ts (role reassignment/clearing) and routes/state.ts
 * (employee disable/delete via the bulk save). Both need the same question
 * answered: "if this request goes through, does anyone with Super Admin still
 * exist?" — so the counting logic lives in one place instead of two.
 *
 * "Holds Super Admin" means employees.role_id (or users.role_id) points at
 * the system role with key `super_admin`. An employee only counts while their
 * employment status is 'active' — พ้นสภาพ/ลา is functionally locked out
 * already, so it must not be treated as a working safety net. System accounts
 * (`users`) have no employment-status concept of their own, so every one that
 * holds the role counts unconditionally.
 * ============================================================================
 */
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { roles, employees, users } from '../db/schema.js';
import { SUPER_ADMIN_KEY } from './permissions.js';

/** The Super Admin role row, or null if the seed somehow hasn't run yet. */
export async function getSuperAdminRole(db: DB) {
  const [row] = await db.select().from(roles).where(eq(roles.key, SUPER_ADMIN_KEY));
  return row ?? null;
}

export interface SuperAdminHolders {
  /** Employee ids currently holding the role with an active employment status. */
  employeeIds: string[];
  /** System account ids currently holding the role. */
  userIds: number[];
}

/** Every account that can actually act as Super Admin right now, as stored. */
export async function activeSuperAdminHolders(db: DB): Promise<SuperAdminHolders> {
  const role = await getSuperAdminRole(db);
  if (!role) return { employeeIds: [], userIds: [] };
  const empRows = await db
    .select({ id: employees.id, data: employees.data })
    .from(employees)
    .where(eq(employees.roleId, role.id));
  const employeeIds = empRows
    .filter((r) => (((r.data as Record<string, unknown> | null)?.status as string | undefined) ?? 'active') === 'active')
    .map((r) => r.id);
  const userRows = await db.select({ id: users.id }).from(users).where(eq(users.roleId, role.id));
  return { employeeIds, userIds: userRows.map((r) => r.id) };
}

export function totalHolders(h: SuperAdminHolders): number {
  return h.employeeIds.length + h.userIds.length;
}
