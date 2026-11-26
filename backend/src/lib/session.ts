import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import type { JwtPayload } from './jwt.js';

/** An employee token stays valid only while the account exists, is not
 *  suspended, and has not had its sessions revoked since sign-in. System
 *  (`users`) tokens are unaffected. */
export async function sessionStillValid(user: JwtPayload): Promise<boolean> {
  if (!user.employeeId) return true;
  const [row] = await getDb()
    .select({ active: employees.accountActive, version: employees.sessionVersion })
    .from(employees)
    .where(eq(employees.id, user.employeeId));
  return Boolean(row && row.active && row.version === (user.sv ?? 0));
}
