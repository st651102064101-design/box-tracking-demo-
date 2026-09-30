import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import type { JwtPayload } from './jwt.js';
import { ALL_PERMISSIONS } from './permission-catalog.js';

type DbResult<T> = { rows?: T[] };
type RoleRow = { id: number; key: string; name: string; description: string; active: boolean; system: boolean };

export async function readRole(id: number): Promise<(RoleRow & { permissions: string[] }) | null> {
  const result = await getDb().execute(sql`
    SELECT r.id, r.key, r.name, r.description, r.active, r.system,
           COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), ARRAY[]::text[]) AS permissions
    FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
    WHERE r.id = ${id} AND r.deleted_at IS NULL
    GROUP BY r.id LIMIT 1
  `);
  const row = (result as unknown as DbResult<RoleRow & { permissions: string[] }>).rows?.[0];
  return row ?? null;
}

export async function effectiveRole(user: JwtPayload | undefined) {
  if (!user) return { roleId: null, key: null, name: null, description: null, active: false, permissions: [] as string[] };
  // The bootstrap admin account may predate RBAC role rows (and role grants
  // are managed separately from the legacy user table). Preserve the explicit
  // top-level admin authority rather than accidentally locking the owner out.
  if (user.role === 'admin') return { roleId: null, key: 'admin', name: 'Administrator', description: 'System administrator', active: true, permissions: ALL_PERMISSIONS.slice() };
  let roleId: number | null = null;
  if (user.employeeId) {
    const result = await getDb().execute(sql`
      SELECT COALESCE(e.role_id, NULLIF(e.data->>'roleId','')::integer, linked.role_id) AS role_id
      FROM employees e LEFT JOIN users linked ON linked.id = e.user_id
      WHERE e.id = ${String(user.sub)} LIMIT 1
    `);
    const row = (result as unknown as DbResult<{ role_id: number | null }>).rows?.[0];
    roleId = row?.role_id ?? null;
  } else if (/^\d+$/.test(String(user.sub))) {
    const result = await getDb().execute(sql`
      SELECT COALESCE(u.role_id, r.id) AS role_id
      FROM users u LEFT JOIN roles r ON r.key = CASE lower(u.role)
        WHEN 'admin' THEN 'admin' WHEN 'viewer' THEN 'viewer'
        WHEN 'supervisor' THEN 'warehouse_manager' ELSE 'warehouse_staff' END
      WHERE u.id = ${Number(user.sub)} LIMIT 1
    `);
    const row = (result as unknown as DbResult<{ role_id: number | null }>).rows?.[0];
    roleId = row?.role_id ?? null;
  }
  const role = roleId == null ? null : await readRole(roleId);
  if (!role) return { roleId: null, key: null, name: null, description: null, active: false, permissions: [] as string[] };
  return { roleId: role.id, key: role.key, name: role.name, description: role.description, active: role.active, permissions: role.active ? role.permissions : [] };
}
