/**
 * Server-side counterpart to legacy.html's client-side auditEntry() — lets
 * backend routes (PDA-facing ones especially: PIN reset, RFID association,
 * employee credentials) write into the same Audit Log the legacy dashboard
 * reads, instead of that log only ever seeing actions taken through
 * legacy.html itself.
 *
 * The `data` field is what actually matters here: GET /api/state only ever
 * surfaces `auditLog.data` to the client (see composeState in state.ts), so
 * a row inserted with the typed columns set but `data` left at its `{}`
 * default is invisible to the Audit Log page even though it's really in the
 * table. This helper builds `data` in the exact shape legacy.html's own
 * auditEntry() produces, so entries from either source render identically.
 *
 * Safe to call outside a transaction or inside one (pass `tx` as `db`) — see
 * replaceState() in state.ts for why audit_log is append-only and no longer
 * wiped on every legacy.html save (it used to be, which would have silently
 * deleted every row written here).
 */
import type { DB } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntryInput {
  action: string;
  actor: string;
  itemId: string;
  itemName: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAuditLog(db: DB, entry: AuditEntryInput): Promise<void> {
  const ts = new Date();
  await db.insert(auditLog).values({
    action: entry.action,
    actor: entry.actor,
    entityId: entry.itemId,
    entityName: entry.itemName,
    before: (entry.before as object) ?? null,
    after: (entry.after as object) ?? null,
    data: {
      ts: ts.toISOString(),
      action: entry.action,
      recorder: entry.actor,
      itemId: entry.itemId,
      itemName: entry.itemName,
      before: entry.before ? JSON.stringify(entry.before) : '',
      after: entry.after ? JSON.stringify(entry.after) : '',
    },
    ts,
  });
}
