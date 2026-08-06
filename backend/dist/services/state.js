/**
 * The heart of the "keep the frontend 100% identical" bridge.
 *
 * The legacy single-page app owns one big runtime object `S` and used to
 * persist it wholesale to localStorage. Here we translate between that `S`
 * snapshot and the normalized Postgres tables:
 *   - composeState():  DB rows  → S   (used by GET  /api/state)
 *   - replaceState():  S        → DB  (used by PUT  /api/state)
 *
 * Every entity keeps a verbatim `data` JSONB copy, so the round-trip is lossless
 * while the extracted typed columns stay available for real SQL/reporting.
 */
import { asc, desc, sql } from 'drizzle-orm';
import { boxes, customers, boxTypes, warehouses, gates, locations, employees, vehicles, doRecords, putaway, inventory, events, auditLog, config, sequences, } from '../db/schema.js';
/* ─── helpers ──────────────────────────────────────────────────────────────*/
const toDate = (v) => {
    if (!v)
        return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};
const toNumStr = (v) => v === null || v === undefined || v === '' ? null : String(v);
const toInt = (v) => {
    if (v === null || v === undefined || v === '')
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};
/* ─── DB → S ───────────────────────────────────────────────────────────────*/
export async function composeState(db) {
    const [boxRows, custRows, btRows, whRows, gateRows, locRows, empRows, vehRows, doRows, putRows, invRows, eventRows, auditRows, cfgRows, seqRows,] = await Promise.all([
        db.select().from(boxes),
        db.select().from(customers),
        db.select().from(boxTypes),
        db.select().from(warehouses),
        db.select().from(gates),
        db.select().from(locations),
        db.select().from(employees),
        db.select().from(vehicles),
        db.select().from(doRecords),
        db.select().from(putaway),
        db.select().from(inventory),
        db.select().from(events).orderBy(asc(events.id)),
        /* newest-first by ts, not insertion order — audit_log is append-only now
           (see replaceState below), so id order no longer tracks recency */
        db.select().from(auditLog).orderBy(desc(auditLog.ts)),
        db.select().from(config),
        db.select().from(sequences),
    ]);
    const mapBy = (rows, key) => Object.fromEntries(rows.map((r) => [key(r), r.data]));
    const cfgRow = cfgRows[0];
    const cfg = cfgRow
        ? { agingDays: cfgRow.agingDays, boxValue: Number(cfgRow.boxValue), lostMode: cfgRow.lostMode }
        : { agingDays: 15, boxValue: 450, lostMode: 'manual' };
    return {
        boxes: mapBy(boxRows, (r) => r.tag),
        customers: mapBy(custRows, (r) => r.id),
        boxtypes: mapBy(btRows, (r) => r.id),
        warehouses: mapBy(whRows, (r) => r.id),
        gates: Object.fromEntries(gateRows.map((r) => [String(r.gateNo), r.warehouseId])),
        events: eventRows.map((r) => r.data),
        cfg,
        seq: Object.fromEntries(seqRows.map((r) => [r.name, r.value])),
        vehicles: mapBy(vehRows, (r) => r.id),
        putaway: mapBy(putRows, (r) => r.id),
        doRecords: mapBy(doRows, (r) => r.id),
        /* `userId`, PIN status, and employee-login status are typed columns, not
           part of the client-editable `data` blob — merge them in so the frontend
           can see them. `hasPin`/`hasLogin`/`loginUsername` are surfaced (never
           the hashes, and `loginUsername` only because a username isn't a secret)
           so the employee master page can show status without the API ever
           handing back anything usable to guess or replay. */
        employees: Object.fromEntries(empRows.map((r) => [
            r.id,
            {
                ...r.data,
                userId: r.userId,
                hasPin: !!r.pinHash,
                hasLogin: !!r.passwordHash,
                loginUsername: r.username ?? null,
            },
        ])),
        locations: mapBy(locRows, (r) => r.code),
        inventory: mapBy(invRows, (r) => r.id),
        auditLog: auditRows.map((r) => r.data),
    };
}
/* ─── S → DB (wholesale replace, transactional) ────────────────────────────*/
export async function replaceState(db, s) {
    await db.transaction(async (tx) => {
        // The legacy web UI calls this on essentially every edit (see the
        // frequent PUT /api/state traffic in the logs), and this whole
        // function is delete-everything-then-reinsert — two of those firing
        // close together (a double-click, two tabs, an autosave racing a
        // manual save) is exactly what produced a live 500: TX A deletes and
        // starts inserting 'BOX-007'; TX B, mid-flight against the same
        // pre-delete snapshot, inserts its own 'BOX-007' row right into the
        // gap, and one of them hits `boxes_pkey` on a table it just wiped in
        // its own transaction. A session-scoped advisory lock serializes
        // concurrent replaceState calls so the second one simply waits for the
        // first to finish (and see its result) instead of interleaving with
        // it — cheap (released automatically at commit/rollback) and doesn't
        // touch any table's own row-level locking.
        await tx.execute(sql `SELECT pg_advisory_xact_lock(727001)`);
        // PDA PIN data (pinHash / pending email-reset OTP) and each employee's
        // own web-app login (username/passwordHash) never round-trip through the
        // legacy `S.employees` payload — the frontend that calls PUT /api/state
        // has no idea either exists. Capture both before the wipe below so every
        // employee save from the web app doesn't silently erase them.
        const pinById = new Map((await tx
            .select({
            id: employees.id,
            pinHash: employees.pinHash,
            pinResetOtpHash: employees.pinResetOtpHash,
            pinResetExpiresAt: employees.pinResetExpiresAt,
            username: employees.username,
            passwordHash: employees.passwordHash,
        })
            .from(employees)).map((r) => [r.id, r]));
        // 1) wipe all domain tables (users are untouched)
        // audit_log is deliberately NOT wiped here — see the audit log section
        // below for why (backend routes now write into it directly too).
        await Promise.all([
            tx.delete(boxes),
            tx.delete(customers),
            tx.delete(boxTypes),
            tx.delete(warehouses),
            tx.delete(gates),
            tx.delete(locations),
            tx.delete(employees),
            tx.delete(vehicles),
            tx.delete(doRecords),
            tx.delete(putaway),
            tx.delete(inventory),
            tx.delete(events),
            tx.delete(sequences),
        ]);
        // 2) config singleton (upsert id=1)
        const cfg = s.cfg ?? {};
        await tx
            .insert(config)
            .values({
            id: 1,
            agingDays: toInt(cfg.agingDays) ?? 15,
            boxValue: toNumStr(cfg.boxValue) ?? '450',
            lostMode: cfg.lostMode ?? 'manual',
            updatedAt: new Date(),
        })
            .onConflictDoUpdate({
            target: config.id,
            set: {
                agingDays: toInt(cfg.agingDays) ?? 15,
                boxValue: toNumStr(cfg.boxValue) ?? '450',
                lostMode: cfg.lostMode ?? 'manual',
                updatedAt: new Date(),
            },
        });
        // 3) sequences
        const seqRows = Object.entries(s.seq ?? {}).map(([name, value]) => ({
            name,
            value: toInt(value) ?? 0,
        }));
        if (seqRows.length)
            await tx.insert(sequences).values(seqRows);
        // 4) boxes
        const boxRows = Object.entries(s.boxes ?? {}).map(([tag, raw]) => {
            const b = raw;
            return {
                tag,
                type: b.type ?? null,
                value: toNumStr(b.value),
                status: b.status ?? 'pending',
                cycles: toInt(b.cycles) ?? 0,
                customer: b.customer ?? null,
                doNo: b.do ?? null,
                po: b.po ?? null,
                outGate: toInt(b.outGate),
                outWh: b.outWh ?? null,
                outAt: toDate(b.outAt),
                dueAt: toDate(b.dueAt),
                lastSeenAt: toDate(b.lastSeenAt),
                labeled: b.labeled !== false,
                // The legacy UI round-trips whatever GET /api/state gave it
                // (composeState returns `data` verbatim, which includes these once
                // POST /api/boxes/:tag/rfid has set them), so a full-state PUT after
                // that has to re-extract them into the typed columns too — otherwise
                // a save from the legacy UI would silently make the box unfindable
                // by RFID again despite `data.rfidTid` still being right there.
                rfidTid: b.rfidTid ?? null,
                rfidEpc: b.rfidEpc ?? null,
                location: b.location ?? {},
                history: b.history ?? [],
                data: b,
                updatedAt: new Date(),
            };
        });
        await chunkInsert(tx, boxes, boxRows);
        // 5) master data
        await chunkInsert(tx, customers, Object.entries(s.customers ?? {}).map(([id, raw]) => {
            const c = raw;
            return {
                id,
                name: c.name ?? null,
                addr: c.addr ?? null,
                contact: c.contact ?? null,
                returnDays: toInt(c.returnDays),
                data: c,
                updatedAt: new Date(),
            };
        }));
        await chunkInsert(tx, boxTypes, Object.entries(s.boxtypes ?? {}).map(([id, raw]) => {
            const t = raw;
            return {
                id,
                name: t.name ?? null,
                unit: t.unit ?? null,
                value: toNumStr(t.value),
                dim: t.dim ?? null,
                data: t,
                updatedAt: new Date(),
            };
        }));
        await chunkInsert(tx, warehouses, Object.entries(s.warehouses ?? {}).map(([id, raw]) => {
            const w = raw;
            return {
                id,
                name: w.name ?? null,
                gateType: w.gateType ?? null,
                gates: w.gates ?? [],
                gateTypes: w.gateTypes ?? {},
                data: w,
                updatedAt: new Date(),
            };
        }));
        await chunkInsert(tx, locations, Object.entries(s.locations ?? {}).map(([code, raw]) => {
            const l = raw;
            return {
                code,
                wh: l.wh ?? null,
                zone: l.zone ?? null,
                rack: l.rack ?? null,
                shelf: l.shelf ?? null,
                slot: l.slot ?? null,
                type: l.type ?? null,
                note: l.note ?? null,
                data: l,
                updatedAt: new Date(),
            };
        }));
        await chunkInsert(tx, employees, Object.entries(s.employees ?? {}).map(([id, raw]) => {
            const e = raw;
            const pin = pinById.get(id);
            return {
                id,
                name: e.name ?? null,
                role: e.role ?? null,
                /* This table is wiped and fully reinserted on every save() — userId
                   is a typed column, not part of `data`, so it must be carried over
                   explicitly here or the account link set via PATCH /link would be
                   silently dropped on the very next unrelated state save. Same
                   reasoning for the PIN/login columns, captured into pinById above
                   since they never round-trip through `data` at all (see composeState). */
                userId: toInt(e.userId),
                data: e,
                pinHash: pin?.pinHash ?? null,
                pinResetOtpHash: pin?.pinResetOtpHash ?? null,
                pinResetExpiresAt: pin?.pinResetExpiresAt ?? null,
                username: pin?.username ?? null,
                passwordHash: pin?.passwordHash ?? null,
                updatedAt: new Date(),
            };
        }));
        // 6) simple keyed maps
        for (const [tbl, map] of [
            [vehicles, s.vehicles],
            [doRecords, s.doRecords],
            [putaway, s.putaway],
            [inventory, s.inventory],
        ]) {
            await chunkInsert(tx, tbl, Object.entries(map ?? {}).map(([id, raw]) => ({ id, data: raw, updatedAt: new Date() })));
        }
        // 7) gates lookup (gate# → warehouseId)
        await chunkInsert(tx, gates, Object.entries(s.gates ?? {})
            .map(([g, wh]) => ({ gateNo: toInt(g), warehouseId: wh ?? null }))
            .filter((r) => r.gateNo !== null));
        // 8) event stream (preserve array order → serial id order)
        await chunkInsert(tx, events, (s.events ?? []).map((e) => {
            const ev = e;
            return { ts: toDate(ev.ts) ?? new Date(), data: ev };
        }));
        // 9) audit log — APPEND ONLY. Backend routes (RFID association, PIN
        // reset, employee credentials — see services/audit.ts) insert straight
        // into this table so PDA-driven changes show up in the same Audit Log
        // the legacy dashboard reads. Wiping the table here on every legacy.html
        // save (like every other table above) would silently delete anything
        // those routes wrote between saves, since the client's local S.auditLog
        // has no way to know about them. Instead, only add entries the client
        // has that the DB doesn't already have — deduped on
        // (ts, action, entityId, actor) since plain audit rows have no
        // client-supplied id to key off more precisely; two distinct real
        // actions colliding on all four in the same millisecond isn't a
        // realistic risk for this app's traffic.
        const existingAuditRows = await tx
            .select({ ts: auditLog.ts, action: auditLog.action, entityId: auditLog.entityId, actor: auditLog.actor })
            .from(auditLog);
        const auditKey = (ts, action, entityId, actor) => `${ts.toISOString()}|${action}|${entityId}|${actor}`;
        const existingAuditKeys = new Set(existingAuditRows.map((r) => auditKey(r.ts, r.action, r.entityId, r.actor)));
        const newAuditRows = (s.auditLog ?? [])
            .map((a) => {
            const e = a;
            return {
                action: e.action ?? null,
                actor: e.recorder ?? null,
                entityId: e.itemId ?? null,
                entityName: e.itemName ?? null,
                before: e.before ?? null,
                after: e.after ?? null,
                data: e,
                ts: toDate(e.ts) ?? new Date(),
            };
        })
            .filter((r) => !existingAuditKeys.has(auditKey(r.ts, r.action, r.entityId, r.actor)));
        await chunkInsert(tx, auditLog, newAuditRows);
    });
}
/** Insert in bounded chunks to stay well under Postgres' bind-parameter limit. */
async function chunkInsert(tx, table, rows, size = 400) {
    for (let i = 0; i < rows.length; i += size) {
        const slice = rows.slice(i, i + size);
        if (slice.length)
            await tx.insert(table).values(slice);
    }
}
//# sourceMappingURL=state.js.map