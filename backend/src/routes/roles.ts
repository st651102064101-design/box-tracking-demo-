/**
 * ============================================================================
 * Role & Permission (RBAC) admin API
 * ----------------------------------------------------------------------------
 * Employee → Role → Permissions. Admins compose roles out of the fixed
 * permission catalog in lib/permissions.ts; they can never mint a new
 * permission key, because a key no route checks would be a lie on the screen.
 *
 * Guarded by role.manage / permission.manage — the two permissions that let an
 * account change who can do what. Read access needs either; writing a role's
 * permission set needs permission.manage specifically, so "can create a role"
 * and "can hand out privileges" stay separable.
 *
 * Super Admin (roles.system) is immutable here on purpose: it is the account
 * class that can undo a misconfiguration, so no request through this API may
 * disable it, strip it, or delete it.
 * ============================================================================
 */
import { Router } from 'express';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { requireAuth, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { getDb } from '../db/client.js';
import { roles, rolePermissions, users, employees } from '../db/schema.js';
import {
  PERMISSION_MODULES,
  ALL_PERMISSIONS,
  SUPER_ADMIN_KEY,
  sanitizePermissions,
} from '../lib/permissions.js';
import { invalidateRoleCache, effectivePermissions } from '../lib/effectivePermissions.js';
import { activeSuperAdminHolders, totalHolders } from '../lib/superAdminGuard.js';
import { writeAuditLog } from '../services/audit.js';

export const rolesRouter = Router();

rolesRouter.use(requireAuth);

const canRead = requireAnyPermission('role.manage', 'permission.manage');
const canWrite = requirePermission('role.manage');
const canGrant = requirePermission('permission.manage');

function forbidden(res: import('express').Response, message: string) {
  return res.status(403).json({ error: 'forbidden', message });
}

/** The last-Super-Admin guard is a state conflict, not a permission problem —
 *  the caller may well hold permission.manage and still not be allowed to
 *  leave the system with zero Super Admins. 409, matching the role_in_use
 *  conflict below, not 403. */
function conflict(res: import('express').Response, code: string, message: string) {
  return res.status(409).json({ error: code, message });
}

/** Slug for a new role, unique-ified against what already exists. */
function keyFromName(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'role';
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

/** How many principals sit on each role — the number the delete guard and the
 *  role table's "พนักงาน" column both need. Counts BOTH tables: employees carry
 *  their own role, and system/service accounts live in `users`. Counting only
 *  one of them would let a role still in use by the other be deleted. */
async function memberCounts(): Promise<Map<number, number>> {
  const db = getDb();
  const counts = new Map<number, number>();
  const bump = (id: number | null) => {
    if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  (await db.select({ roleId: users.roleId }).from(users)).forEach((r) => bump(r.roleId));
  (await db.select({ roleId: employees.roleId }).from(employees)).forEach((r) => bump(r.roleId));
  return counts;
}

/* ─── catalog ─────────────────────────────────────────────────────────────*/
/** The permission picker's contents. Deliberately readable by any signed-in
 *  account: the employee form shows a role's permissions read-only. */
rolesRouter.get(
  '/permissions',
  asyncHandler(async (_req, res) => {
    res.json({ modules: PERMISSION_MODULES, total: ALL_PERMISSIONS.length });
  }),
);

/** What *this* caller may do — drives menu/button visibility in the UI. */
rolesRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json(await effectivePermissions(req.user));
  }),
);

/* ─── list ────────────────────────────────────────────────────────────────*/
rolesRouter.get(
  '/',
  canRead,
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const roleRows = await db.select().from(roles).where(isNull(roles.deletedAt));
    const permRows = roleRows.length
      ? await db
          .select()
          .from(rolePermissions)
          .where(inArray(rolePermissions.roleId, roleRows.map((r) => r.id)))
      : [];
    const permsByRole = new Map<number, string[]>();
    for (const p of permRows) {
      const list = permsByRole.get(p.roleId) ?? [];
      list.push(p.permission);
      permsByRole.set(p.roleId, list);
    }
    const counts = await memberCounts();

    res.json({
      /* total ของ endpoint นี้คือจำนวนบทบาท ไม่ใช่จำนวน permission ในระบบ
         ไม่อย่างนั้น UI จะแสดง badge ว่ามีบทบาทหลายรายการ แต่ตารางอาจว่างได้ */
      total: roleRows.length,
      roles: roleRows
        .map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          description: r.description,
          active: r.active,
          system: r.system,
          members: counts.get(r.id) ?? 0,
          permissions: sanitizePermissions(permsByRole.get(r.id) ?? []),
        }))
        /* System role first, then by name — Super Admin is the one an admin
           looks for when something has gone wrong. */
        .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name, 'th')),
    });
  }),
);

/** The accounts on a role — what "ดูพนักงานที่ใช้งาน" opens when a delete is
 *  refused because the role is still in use. */
rolesRouter.get(
  '/:id/members',
  canRead,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const roleId = Number(req.params.id);
    const userRows = await db.select().from(users).where(eq(users.roleId, roleId));
    const empRows = userRows.length
      ? await db
          .select()
          .from(employees)
          .where(inArray(employees.userId, userRows.map((u) => u.id)))
      : [];
    const empByUser = new Map(empRows.map((e) => [e.userId, e]));
    /* Employees whose own role_id points here — the majority, and the ones an
       admin actually has to move before the role can be deleted. */
    const ownEmpRows = await db.select().from(employees).where(eq(employees.roleId, roleId));
    const seen = new Set<string>();
    const members = [
      ...userRows.map((u) => ({
        userId: u.id as number | null,
        username: u.username,
        name: u.name,
        employeeId: empByUser.get(u.id)?.id ?? null,
      })),
      ...ownEmpRows.map((e) => ({
        userId: e.userId ?? null,
        username: e.username ?? '',
        name: e.name ?? e.id,
        employeeId: e.id,
      })),
    ].filter((m) => {
      /* An employee linked to a users row that is also on this role would
         otherwise be listed twice. */
      const key = m.employeeId ? 'e:' + m.employeeId : 'u:' + m.userId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json({ members });
  }),
);

/* ─── create ──────────────────────────────────────────────────────────────*/
rolesRouter.post(
  '/',
  canWrite,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'bad_request', message: 'กรุณากรอกชื่อบทบาท' });
    }
    const db = getDb();
    const existing = await db.select().from(roles);
    const liveNameClash = existing.some(
      (r) => !r.deletedAt && r.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (liveNameClash) {
      return res.status(409).json({ error: 'conflict', message: 'มีบทบาทชื่อนี้อยู่แล้ว' });
    }

    const permissions = sanitizePermissions(body.permissions);
    /* Handing out privileges is its own permission: role.manage alone may
       create the role, but only permission.manage may populate it. */
    if (permissions.length && !(req.permissions ?? []).includes('permission.manage')) {
      return forbidden(res, 'คุณไม่มีสิทธิ์กำหนด Permission ให้บทบาท');
    }

    const [row] = await db
      .insert(roles)
      .values({
        key: keyFromName(name, new Set(existing.map((r) => r.key))),
        name,
        description: typeof body.description === 'string' ? body.description.trim() : '',
        active: body.active === undefined ? true : Boolean(body.active),
        system: false,
      })
      .returning();
    if (permissions.length) {
      await db
        .insert(rolePermissions)
        .values(permissions.map((permission) => ({ roleId: row.id, permission })));
    }
    invalidateRoleCache();
    res.status(201).json({ ...row, members: 0, permissions });
  }),
);

/* ─── update ──────────────────────────────────────────────────────────────*/
rolesRouter.put(
  '/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const roleId = Number(req.params.id);
    const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
    if (!role) {
      return res.status(404).json({ error: 'not_found', message: 'ไม่พบบทบาทนี้' });
    }
    if (role.system) {
      return forbidden(res, 'Super Admin เป็นบทบาทของระบบ แก้ไขไม่ได้');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) {
        return res.status(400).json({ error: 'bad_request', message: 'กรุณากรอกชื่อบทบาท' });
      }
      const clash = await db
        .select()
        .from(roles)
        .where(and(eq(roles.name, name), ne(roles.id, roleId), isNull(roles.deletedAt)));
      if (clash.length) {
        return res.status(409).json({ error: 'conflict', message: 'มีบทบาทชื่อนี้อยู่แล้ว' });
      }
      patch.name = name;
    }
    if (typeof body.description === 'string') patch.description = body.description.trim();
    if (body.active !== undefined) patch.active = Boolean(body.active);

    await db.update(roles).set(patch).where(eq(roles.id, roleId));

    if (body.permissions !== undefined) {
      if (!(req.permissions ?? []).includes('permission.manage')) {
        return forbidden(res, 'คุณไม่มีสิทธิ์แก้ไข Permission ของบทบาท');
      }
      const permissions = sanitizePermissions(body.permissions);
      /* An admin must not be able to lock the last door behind themselves:
         if this is their own role, they may not drop role.manage from it. */
      const self = await effectivePermissions(req.user);
      if (self.roleId === roleId && !permissions.includes('role.manage')) {
        return forbidden(res, 'ถอนสิทธิ์ "จัดการ Role" ออกจากบทบาทของตัวเองไม่ได้');
      }
      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      if (permissions.length) {
        await db
          .insert(rolePermissions)
          .values(permissions.map((permission) => ({ roleId, permission })));
      }
    }

    invalidateRoleCache();
    const [updated] = await db.select().from(roles).where(eq(roles.id, roleId));
    const perms = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));
    res.json({ ...updated, permissions: perms.map((p) => p.permission) });
  }),
);

/* ─── delete ──────────────────────────────────────────────────────────────*/
rolesRouter.delete(
  '/:id',
  canWrite,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const roleId = Number(req.params.id);
    const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
    if (!role) {
      return res.status(404).json({ error: 'not_found', message: 'ไม่พบบทบาทนี้' });
    }
    if (role.system) {
      return forbidden(res, 'Super Admin เป็นบทบาทของระบบ ลบไม่ได้');
    }
    /* Deleting a role out from under its members would silently strip them of
       every permission, so the members have to be moved first. */
    const members = (await memberCounts()).get(roleId) ?? 0;
    if (members > 0) {
      return res.status(409).json({
        error: 'role_in_use',
        message: `ไม่สามารถลบบทบาทนี้ได้ เนื่องจากมีพนักงาน ${members} คนกำลังใช้งาน`,
        members,
      });
    }
    /* Soft delete. The row (and its permission grants) survive so "what could
       this role do, back when it existed" stays answerable — role_permissions
       is left alone on purpose, not cleared. A deleted role can never again be
       assigned or listed (every read here filters deletedAt IS NULL /
       effectivePermissions' role cache does the same), so leaving the grants
       in place costs nothing at runtime. */
    await db.update(roles).set({ deletedAt: new Date() }).where(eq(roles.id, roleId));
    invalidateRoleCache();
    res.json({ ok: true });
  }),
);

/* ─── assign a role to an employee ────────────────────────────────────────*/
/** The path the employee form uses. Separate from /assign/:userId because an
 *  employee usually has no `users` row at all — routing everything through
 *  that one was what made roles apply only to accounts with a web login. */
rolesRouter.put(
  '/assign-employee/:employeeId',
  canGrant,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const employeeId = String(req.params.employeeId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
    if (!emp) {
      return res.status(404).json({ error: 'not_found', message: 'ไม่พบพนักงานคนนี้' });
    }

    /* This endpoint's one job is setting the role — unlike PUT /api/state
       (a whole-record replace, where "field absent" legitimately means
       "unchanged"), a request here with no `roleId` key at all is malformed,
       not a no-op. Treating it as "clear the role" is exactly the bug that
       used to wipe an employee's role from a request that only meant to save
       their phone number (the disabled <select> submitted no value at all).
       `roleId: null` is a different thing — that IS the explicit "remove the
       role" request — and still goes through the checks below like anything
       else. */
    if (!('roleId' in body)) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'ต้องระบุ roleId (ส่ง null เพื่อถอดบทบาทออกโดยตั้งใจ)',
      });
    }
    const roleId = body.roleId == null || body.roleId === '' ? null : Number(body.roleId);
    let role: typeof roles.$inferSelect | null = null;
    if (roleId != null) {
      const [r] = await db.select().from(roles).where(eq(roles.id, roleId));
      if (!r) {
        return res.status(400).json({ error: 'bad_request', message: 'ไม่พบบทบาทที่เลือก' });
      }
      role = r;
    }

    /* Same last-Super-Admin guard as /assign/:userId: whoever is the final
       holder of the keys may not hand them away, including to themselves —
       whether that's a move to another role or an explicit clear. Counts only
       ACTIVE holders (see superAdminGuard.ts): a Super Admin who has since
       พ้นสภาพ isn't a usable fallback, so they must not count as "someone
       else still has it". */
    let current: typeof roles.$inferSelect | null = null;
    if (emp.roleId != null && emp.roleId !== roleId) {
      const [c] = await db.select().from(roles).where(eq(roles.id, emp.roleId));
      current = c ?? null;
      if (current?.key === SUPER_ADMIN_KEY) {
        const holders = await activeSuperAdminHolders(db);
        const empIsActive = ((emp.data as Record<string, unknown> | null)?.status ?? 'active') === 'active';
        const remaining = totalHolders(holders) - (empIsActive && holders.employeeIds.includes(employeeId) ? 1 : 0);
        if (remaining <= 0) {
          return conflict(
            res,
            'last_super_admin',
            'ไม่สามารถเปลี่ยนบทบาทได้ เนื่องจากบัญชีนี้เป็น Super Admin คนสุดท้ายของระบบ',
          );
        }
      }
    }

    /* Deliberately does NOT touch a linked `users` row. PUT /api/state links a
       newly created employee to whichever account saved it (see bootstrapUserId
       in services/state.ts), so an admin who adds a warehouse hand and gives
       them a junior role would be writing that junior role onto their OWN
       account. Employee logins resolve through employees.role_id now; system
       accounts are moved explicitly via /assign/:userId. */
    await db.update(employees).set({ roleId }).where(eq(employees.id, employeeId));
    invalidateRoleCache();

    /* Audit only fires when the role actually changed — this route is called
       every time the employee form's role select renders unchanged, and a log
       full of "role changed from X to X" would bury the entries that matter. */
    if (emp.roleId !== roleId) {
      await writeAuditLog(db, {
        action: roleId == null ? 'role_removed' : 'role_changed',
        actor: req.user!.username,
        itemId: employeeId,
        itemName: emp.name ?? employeeId,
        before: { roleId: emp.roleId, roleName: current?.name ?? null },
        after: { roleId, roleName: role?.name ?? null },
      });
    }

    res.json({ ok: true, employeeId, roleId });
  }),
);

/* ─── assign a role to a system account ───────────────────────────────────*/
rolesRouter.put(
  '/assign/:userId',
  canGrant,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const userId = Number(req.params.userId);
    const roleId = Number((req.body ?? {}).roleId);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ไม่พบบัญชีผู้ใช้นี้' });
    }
    const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
    if (!role) {
      return res.status(400).json({ error: 'bad_request', message: 'ไม่พบบทบาทที่เลือก' });
    }

    /* The last Super Admin may not demote themselves — that is the one change
       no one else is left with the rights to undo. Same active-holder count
       as assign-employee above; a `users` account has no employment status of
       its own so it always counts while it holds the role. */
    let current: typeof roles.$inferSelect | null = null;
    if (user.roleId != null && user.roleId !== roleId) {
      const [c] = await db.select().from(roles).where(eq(roles.id, user.roleId));
      current = c ?? null;
      if (current?.key === SUPER_ADMIN_KEY) {
        const holders = await activeSuperAdminHolders(db);
        const remaining = totalHolders(holders) - (holders.userIds.includes(userId) ? 1 : 0);
        if (remaining <= 0) {
          return conflict(
            res,
            'last_super_admin',
            'ไม่สามารถเปลี่ยนบทบาทได้ เนื่องจากบัญชีนี้เป็น Super Admin คนสุดท้ายของระบบ',
          );
        }
      }
    }

    await db.update(users).set({ roleId }).where(eq(users.id, userId));
    invalidateRoleCache();

    if (user.roleId !== roleId) {
      await writeAuditLog(db, {
        action: 'role_changed',
        actor: req.user!.username,
        itemId: String(userId),
        itemName: user.name ?? user.username ?? String(userId),
        before: { roleId: user.roleId, roleName: current?.name ?? null },
        after: { roleId, roleName: role.name },
      });
    }

    res.json({ ok: true, userId, roleId });
  }),
);
