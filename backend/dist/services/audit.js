import { auditLog } from '../db/schema.js';
/** Audit is for employee-caused CRUD only. Hardware telemetry, webhooks,
 * notifications, background jobs and operational scans must not create rows. */
export function isEmployeeCrudAuditEntry(entry) {
    const actor = String(entry.actor ?? entry.recorder ?? '').trim();
    const action = String(entry.action ?? '').trim().toLowerCase();
    if (!actor || /^(system|auto|worker|service|scheduler|fx9600|lpr|webhook)$/i.test(actor))
        return false;
    return /^(create|update|delete|role_change|role_changed|role_removed|reader_(create|update|unbind)|rfid_detach|pin_(set|reset)|credentials_set|unlink_customer_line|ปลดพัก|พักสินค้า|แจ้งชำรุด)$/i.test(action);
}
export async function writeAuditLog(db, entry) {
    if (!isEmployeeCrudAuditEntry(entry))
        return;
    const ts = new Date();
    await db.insert(auditLog).values({
        action: entry.action,
        actor: entry.actor,
        entityId: entry.itemId,
        entityName: entry.itemName,
        before: entry.before ?? null,
        after: entry.after ?? null,
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
//# sourceMappingURL=audit.js.map