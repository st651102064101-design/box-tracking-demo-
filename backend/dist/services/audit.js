import { auditLog } from '../db/schema.js';
export async function writeAuditLog(db, entry) {
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