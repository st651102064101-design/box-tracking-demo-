/**
 * What an account may not do to itself: end its own employment, change its own
 * access, or remove its own record. Someone else has to do those, so nobody can
 * lock themselves out (or dodge a check by editing their own row).
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import type { JwtPayload } from '../lib/jwt.js';
import type { StatePayload } from '../validators/schemas.js';
import type { RejectedGroup } from './stateGuard.js';

type Dict = Record<string, unknown>;

/** The employee records that *are* this caller: its own for an employee login,
 *  the linked ones for a system account. Never matched by name. */
export async function selfEmployeeIds(user: JwtPayload): Promise<string[]> {
  if (user.employeeId) return [user.employeeId];
  const userId = Number(user.sub);
  if (!Number.isInteger(userId)) return [];
  const rows = await getDb().select({ id: employees.id }).from(employees).where(eq(employees.userId, userId));
  return rows.map((r) => r.id);
}

/** True when `userId` is the `users` account the caller signed in with. */
export function isOwnUserAccount(user: JwtPayload, userId: number): boolean {
  return !user.employeeId && Number(user.sub) === userId;
}

/** `status`/`access` as stored; a missing status means active. */
const guarded = (e: Dict) => ({ status: (e.status as string | undefined) || 'active', access: e.access });

export function protectOwnRecords(
  payload: StatePayload,
  stored: Dict,
  ids: string[],
): { payload: StatePayload; rejected: RejectedGroup[] } {
  const incoming = { ...(payload.employees as Record<string, Dict>) };
  const current = (stored.employees ?? {}) as Record<string, Dict>;
  const blocked = new Set<string>();

  for (const id of ids) {
    const before = current[id];
    if (!before) continue;
    const next = incoming[id];
    if (!next) {
      incoming[id] = before;
      blocked.add('ลบ');
      continue;
    }
    const was = guarded(before);
    const now = guarded(next);
    if (was.status === now.status && was.access === now.access) continue;
    if (was.status !== now.status) blocked.add('สถานะ');
    if (was.access !== now.access) blocked.add('สิทธิ์การเข้าถึง');
    incoming[id] = { ...next, status: before.status, access: before.access };
  }
  if (!blocked.size) return { payload, rejected: [] };
  return {
    payload: { ...payload, employees: incoming },
    rejected: [{
      key: 'self',
      label: 'บัญชีของตัวเอง',
      required: [],
      message: `เปลี่ยนของบัญชีตัวเองไม่ได้: ${[...blocked].join(', ')} — ให้ผู้ดูแลคนอื่นทำ`,
    }],
  };
}
