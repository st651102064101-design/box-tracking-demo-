import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import type { JwtPayload } from './jwt.js';

/** Only someone currently working may use the system: "ลา/พักงาน" and
 *  "พ้นสภาพ" both end access. A missing status means active. */
export function isWorking(data: unknown): boolean {
  const status = (data as Record<string, unknown> | null)?.status;
  return !status || status === 'active';
}

/** An employee token stays valid only while the account exists, is working, is not
 *  suspended, and has not had its sessions revoked since sign-in. System
 *  (`users`) tokens are unaffected. */
export async function sessionStillValid(user: JwtPayload): Promise<boolean> {
  if (!user.employeeId) return true;
  const [row] = await getDb()
    .select({ active: employees.accountActive, version: employees.sessionVersion, data: employees.data })
    .from(employees)
    .where(eq(employees.id, user.employeeId));
  return Boolean(row && row.active && isWorking(row.data) && row.version === (user.sv ?? 0));
}
