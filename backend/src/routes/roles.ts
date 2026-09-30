import { Router, type NextFunction, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { ALL_PERMISSIONS, PERMISSION_MODULES, sanitizePermissions } from '../lib/permission-catalog.js';
import { effectiveRole, readRole } from '../lib/role-data.js';

export const rolesRouter = Router();
rolesRouter.use(requireAuth);
type Rows<T> = { rows?: T[] };

function requirePermission(...required: string[]) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const role = await effectiveRole(req.user);
    if (!required.some((key) => role.permissions.includes(key))) {
      res.status(403).json({ error: 'forbidden', message: 'บัญชีนี้ไม่มีสิทธิ์จัดการบทบาทหรือสิทธิ์' });
      return;
    }
    next();
  });
}

export const requirePermissions = requirePermission;

rolesRouter.get('/permissions', (_req, res) => res.json({ modules: PERMISSION_MODULES, total: ALL_PERMISSIONS.length }));
rolesRouter.get('/me', asyncHandler(async (req, res) => res.json(await effectiveRole(req.user))));

rolesRouter.get('/summary', requirePermission('role.manage','permission.manage'), asyncHandler(async (_req, res) => {
  const result = await getDb().execute(sql`
    SELECT r.id, r.key, r.name, r.description, r.active, r.system,
      (SELECT count(*)::int FROM role_permissions p WHERE p.role_id=r.id) AS "permissionCount",
      ((SELECT count(*) FROM users u WHERE u.role_id=r.id) +
       (SELECT count(*) FROM employees e WHERE COALESCE(e.role_id, NULLIF(e.data->>'roleId','')::integer)=r.id))::int AS members
    FROM roles r WHERE r.deleted_at IS NULL ORDER BY r.system DESC, r.name
  `);
  const rows = (result as Rows<Record<string, unknown>>).rows ?? [];
  res.json({ total: rows.length, roles: rows });
}));

rolesRouter.get('/', requirePermission('role.manage','permission.manage'), asyncHandler(async (_req, res) => {
  const result = await getDb().execute(sql`
    SELECT r.id, r.key, r.name, r.description, r.active, r.system,
      COALESCE(array_agg(DISTINCT p.permission) FILTER (WHERE p.permission IS NOT NULL), ARRAY[]::text[]) AS permissions,
      ((SELECT count(*) FROM users u WHERE u.role_id=r.id) +
       (SELECT count(*) FROM employees e WHERE COALESCE(e.role_id, NULLIF(e.data->>'roleId','')::integer)=r.id))::int AS members
    FROM roles r LEFT JOIN role_permissions p ON p.role_id=r.id
    WHERE r.deleted_at IS NULL GROUP BY r.id ORDER BY r.system DESC, r.name
  `);
  const rows = ((result as Rows<Record<string, unknown>>).rows ?? []).map((row) => ({
    ...row,
    permissions: sanitizePermissions(row.permissions),
  }));
  res.json({ total: ALL_PERMISSIONS.length, roles: rows });
}));

rolesRouter.get('/:id/members', requirePermission('role.manage','permission.manage'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'รหัสบทบาทไม่ถูกต้อง' });
  const result = await getDb().execute(sql`
    SELECT e.id AS "employeeId", e.name, COALESCE(e.username, e.data->>'loginUsername') AS username
    FROM employees e WHERE COALESCE(e.role_id, NULLIF(e.data->>'roleId','')::integer)=${id}
    UNION
    SELECT NULL::text AS "employeeId", u.name, u.username FROM users u WHERE u.role_id=${id}
    ORDER BY name
  `);
  res.json({ members: (result as Rows<Record<string, unknown>>).rows ?? [] });
}));

const roleBody = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(1000).optional(), active: z.boolean().optional(), permissions: z.array(z.string()).optional() });
function slug(name: string) { return name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'role'; }
async function writePermissions(roleId: number, permissions: string[]) {
  await getDb().execute(sql`DELETE FROM role_permissions WHERE role_id=${roleId}`);
  for (const permission of permissions) await getDb().execute(sql`INSERT INTO role_permissions (role_id, permission) VALUES (${roleId},${permission}) ON CONFLICT DO NOTHING`);
}

rolesRouter.post('/', requirePermission('role.manage'), asyncHandler(async (req, res) => {
  const input = roleBody.parse(req.body);
  if (!input.name) return res.status(400).json({ message: 'กรุณากรอกชื่อบทบาท' });
  const permissions = sanitizePermissions(input.permissions);
  if (permissions.length && !(await effectiveRole(req.user)).permissions.includes('permission.manage')) return res.status(403).json({ message: 'ไม่มีสิทธิ์กำหนด Permission ให้บทบาท' });
  const db = getDb();
  const keyBase = slug(input.name);
  const keyRows = (await db.execute(sql`SELECT key FROM roles` ) as unknown as Rows<{key:string}>).rows ?? [];
  const keys = new Set(keyRows.map((row) => row.key));
  let key = keyBase, suffix = 2; while (keys.has(key)) key = `${keyBase}_${suffix++}`;
  const inserted = await db.execute(sql`INSERT INTO roles (key,name,description,active,system) VALUES (${key},${input.name},${input.description ?? ''},${input.active ?? true},false) RETURNING id`);
  const id = Number((inserted as unknown as Rows<{id:number}>).rows?.[0]?.id);
  await writePermissions(id, permissions);
  const role = await readRole(id);
  res.status(201).json({ ...role, members: 0 });
}));

rolesRouter.put('/:id', requirePermission('role.manage'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id), input = roleBody.parse(req.body);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'รหัสบทบาทไม่ถูกต้อง' });
  const current = await readRole(id);
  if (!current) return res.status(404).json({ message: 'ไม่พบบทบาทนี้' });
  if (current.system) return res.status(403).json({ message: 'บทบาทผู้ดูแลระบบสูงสุดเป็นบทบาทของระบบ แก้ไขไม่ได้' });
  const permissions = input.permissions === undefined ? undefined : sanitizePermissions(input.permissions);
  if (permissions && !(await effectiveRole(req.user)).permissions.includes('permission.manage')) return res.status(403).json({ message: 'ไม่มีสิทธิ์กำหนด Permission ให้บทบาท' });
  await getDb().execute(sql`UPDATE roles SET name=COALESCE(${input.name ?? null},name), description=COALESCE(${input.description ?? null},description), active=COALESCE(${input.active ?? null},active), updated_at=now() WHERE id=${id}`);
  if (permissions) await writePermissions(id, permissions);
  const role = await readRole(id);
  res.json(role);
}));

rolesRouter.delete('/:id', requirePermission('role.manage'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id), role = Number.isInteger(id) ? await readRole(id) : null;
  if (!role) return res.status(404).json({ message: 'ไม่พบบทบาทนี้' });
  if (role.system) return res.status(403).json({ message: 'ลบบทบาทระบบไม่ได้' });
  const result = await getDb().execute(sql`
    SELECT ((SELECT count(*) FROM users WHERE role_id=${id}) +
            (SELECT count(*) FROM employees WHERE COALESCE(role_id,NULLIF(data->>'roleId','')::integer)=${id}))::int AS members
  `);
  const members = Number((result as unknown as Rows<{members:number}>).rows?.[0]?.members ?? 0);
  if (members) return res.status(409).json({ error: 'role_in_use', members, message: `มีบัญชีหรือพนักงานใช้บทบาทนี้ ${members} รายการ` });
  await getDb().execute(sql`UPDATE roles SET deleted_at=now(), updated_at=now() WHERE id=${id}`);
  res.json({ ok: true });
}));

rolesRouter.put('/assign-employee/:id', requirePermission('permission.manage'), asyncHandler(async (req, res) => {
  const roleId = req.body?.roleId == null || req.body.roleId === '' ? null : Number(req.body.roleId);
  if (roleId != null && (!Number.isInteger(roleId) || !(await readRole(roleId)))) return res.status(400).json({ message: 'บทบาทที่เลือกไม่ถูกต้อง' });
  const updated = await getDb().execute(sql`
    UPDATE employees SET role_id=${roleId},
      data=CASE WHEN ${roleId}::integer IS NULL THEN data-'roleId'-'roleName'
        ELSE jsonb_set(jsonb_set(data,'{roleId}',to_jsonb(${roleId}::integer),true),'{roleName}',to_jsonb((SELECT name FROM roles WHERE id=${roleId})),true) END,
      updated_at=now()
    WHERE id=${req.params.id} RETURNING id
  `);
  if (!(updated as unknown as Rows<{id:string}>).rows?.length) return res.status(404).json({ message: 'ไม่พบพนักงาน' });
  res.json({ ok: true });
}));
