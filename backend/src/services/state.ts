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
import { asc, desc, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  boxes,
  customers,
  boxTypes,
  warehouses,
  gates,
  gateWebhookStatus,
  rfidReaders,
  locations,
  employees,
  vehicles,
  doRecords,
  putaway,
  inventory,
  events,
  auditLog,
  config,
  sequences,
} from '../db/schema.js';
import type { StatePayload } from '../validators/schemas.js';
import type { JwtPayload } from '../lib/jwt.js';
import { env } from '../env.js';
import {
  sendGateInNotifications,
  sendGateOutLineNotification,
  type GateInNotificationInput,
  type GateOutLineInput,
} from './autoLineNotifications.js';
import { isEmployeeCrudAuditEntry } from './audit.js';

// A full audit reset must not be undone by an already-open browser posting its
// cached pre-reset audit array back through the legacy whole-state endpoint.
const AUDIT_CACHE_CUTOFF = new Date();
const LINE_USER_ID = /^U[0-9a-f]{32}$/i;

/* ─── helpers ──────────────────────────────────────────────────────────────*/
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};
const toNumStr = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);
const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* The legacy page still saves a complete state snapshot.  An LPR callback can
   arrive between its GET and PUT, so the browser's older `history` array must
   never erase camera evidence that was already committed by the webhook. */
const isLprHistory = (entry: unknown): entry is Record<string, unknown> =>
  !!entry && typeof entry === 'object' && (entry as Record<string, unknown>).dir === 'lpr';

const lprHistoryKey = (entry: Record<string, unknown>): string =>
  String(entry.eventId ?? `${entry.ts ?? ''}|${entry.gateNo ?? entry.gate ?? ''}|${entry.plateNumber ?? ''}`);

const mergeLprHistory = (browserHistory: unknown, persistedHistory: unknown): unknown[] => {
  const fromBrowser = Array.isArray(browserHistory) ? browserHistory : [];
  const known = new Set(fromBrowser.filter(isLprHistory).map(lprHistoryKey));
  const missingPersisted = (Array.isArray(persistedHistory) ? persistedHistory : [])
    .filter(isLprHistory)
    .filter((entry) => !known.has(lprHistoryKey(entry)));
  return [...fromBrowser, ...missingPersisted];
};

/* ─── DB → S ───────────────────────────────────────────────────────────────*/
export async function composeState(db: DB): Promise<Record<string, unknown>> {
  const [
    boxRows,
    custRows,
    btRows,
    whRows,
    gateRows,
    gateStatusRows,
    readerRows,
    locRows,
    empRows,
    vehRows,
    doRows,
    putRows,
    invRows,
    eventRows,
    auditRows,
    cfgRows,
    seqRows,
  ] = await Promise.all([
    db.select().from(boxes),
    /* Soft-deleted rows never round-trip through the legacy S blob — a
       deleted customer/box type must vanish from the SPA's own lists too, not
       just the REST endpoints (see routes/masters.ts DELETE handlers). */
    db.select().from(customers).where(isNull(customers.deletedAt)),
    db.select().from(boxTypes).where(isNull(boxTypes.deletedAt)),
    db.select().from(warehouses),
    db.select().from(gates),
    db.select().from(gateWebhookStatus),
    db.select().from(rfidReaders),
    db.select().from(locations),
    db.select().from(employees),
    db.select().from(vehicles),
    db.select().from(doRecords),
    db.select().from(putaway),
    db.select().from(inventory),
    db.select().from(events).orderBy(asc(events.id)),
    /* Audit is append-only and can grow very quickly (FX9600 heartbeats are
       operational events).  It must never be included wholesale in the SPA's
       full-state snapshot: that causes a multi-megabyte GET /api/state, then
       the browser mirrors it back in PUT /api/state and hits request limits.
       The UI only needs recent activity; the complete audit stays in DB. */
    db.select().from(auditLog).orderBy(desc(auditLog.ts)).limit(500),
    db.select().from(config),
    db.select().from(sequences),
  ]);

  const mapBy = <T extends { data: unknown }>(rows: T[], key: (r: T) => string) =>
    Object.fromEntries(rows.map((r) => [key(r), r.data]));

  const cfgRow = cfgRows[0];
  const cfg = cfgRow
    ? { agingDays: cfgRow.agingDays, boxValue: Number(cfgRow.boxValue), lostMode: cfgRow.lostMode }
    : { agingDays: 15, boxValue: 450, lostMode: 'manual' };

  return {
    boxes: mapBy(boxRows, (r) => r.tag),
    customers: Object.fromEntries(custRows.map((r) => [r.id, {
      ...(r.data as Record<string, unknown>),
      lineUserId: r.lineUserId ?? (r.data as Record<string, unknown>).lineUserId ?? '',
      lineDisplayName: r.lineDisplayName ?? '',
      linePictureUrl: r.linePictureUrl ?? '',
      lineLinkedAt: r.lineLinkedAt?.toISOString() ?? '',
      contactEmail: r.contactEmail ?? (r.data as Record<string, unknown>).contactEmail ?? '',
    }])),
    boxtypes: mapBy(btRows, (r) => r.id),
    warehouses: mapBy(whRows, (r) => r.id),
    gates: Object.fromEntries(gateRows.map((r) => [String(r.gateNo), r.warehouseId])),
    /* Read-only from the client's point of view — see the schema.sql comment
       on gate_webhook_status for why this is a separate table from `gates`.
       Only the FX9600 webhook route (routes/rfid.ts) ever writes to it;
       replaceState() below doesn't touch it, so nothing sent via PUT
       /api/state can clobber or fake a "connected" status. */
    gateWebhookLastSeen: Object.fromEntries(
      gateStatusRows.map((r) => [String(r.gateNo), r.lastSeenAt.toISOString()]),
    ),
    /* Diagnostic source IP only. Docker may report the bridge gateway here,
       so this value must never be used as the reader administration URL. */
    gateWebhookLastIp: Object.fromEntries(
      gateStatusRows.filter((r) => r.lastIp).map((r) => [String(r.gateNo), r.lastIp as string]),
    ),
    gateHeartbeatIntervalSeconds: Object.fromEntries(
      readerRows.map((r) => [String(r.gateNo), r.heartbeatIntervalSeconds]),
    ),
    // Read-only site configuration for the FX9600 administration UI.
    fx9600AdminUrl: env.fx9600AdminUrl,
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
    employees: Object.fromEntries(
      empRows.map((r) => [
        r.id,
        {
          ...(r.data as Record<string, unknown>),
          userId: r.userId,
          /* Overrides whatever copy of roleId the blob is carrying: the column
             is the one permission checks read, so the screen must show that
             and not a stale value from the last client that saved state. */
          roleId: r.roleId,
          hasPin: !!r.pinHash,
          hasLogin: !!r.passwordHash,
          loginUsername: r.username ?? null,
        },
      ]),
    ),
    locations: mapBy(locRows, (r) => r.code),
    inventory: mapBy(invRows, (r) => r.id),
    auditLog: auditRows
      .map((r) => r.data)
      .filter((entry) => isEmployeeCrudAuditEntry(entry as Record<string, unknown>)),
  };
}

/* ─── S → DB (wholesale replace, transactional) ────────────────────────────*/
/**
 * One advisory lock id for "somebody is writing the whole state snapshot".
 * Arbitrary constant; it only has to be stable and not collide with another
 * advisory lock in this database.
 */
const STATE_WRITE_LOCK = 4711_0001;

/**
 * Upsert `rows` into a table keyed by a single primary-key column, then delete
 * the rows that key is no longer present in the payload.
 *
 * This replaces the delete-everything-then-insert-everything pass this function
 * used to do, which was the source of the duplicate-primary-key 500s: two
 * overlapping PUT /api/state transactions each deleted the rows visible in
 * their own READ COMMITTED snapshot, so the second one's DELETE could not see
 * the rows the first had just inserted, left them in place, and then collided
 * with them on INSERT ("duplicate key value violates constraint boxes_pkey").
 * Existing rows are now UPDATEd in place and only genuinely absent ones are
 * deleted, so re-sending the same snapshot is idempotent.
 */
interface SyncKeyedOpts {
  size?: number;
  /** Columns to leave alone on conflict — the row proposed by a client save
   *  never carries these, so writing `excluded.<col>` for them would reset
   *  every existing row to that column's blank default on every ordinary
   *  save. `deletedAt` is exactly that case: composeState excludes
   *  soft-deleted rows from what any client ever sees, so a save from a
   *  client that hasn't refreshed since a delete has no way to *know* to
   *  preserve deletedAt — the sync layer has to do it for them. */
  preserveCols?: string[];
  /** Scopes the prune step's "what's already stored" query. A soft-deleted
   *  row must never appear there — it is not "missing from this snapshot", it
   *  was excluded from what any client can ever see (composeState), so it is
   *  outside this function's job entirely. Without this, the very next save
   *  from any client that hasn't refreshed since the delete would prune it as
   *  gone and hard-delete it for real.
   *
   *  Note: this does not stop `preserveCols` deletedAt from surviving an
   *  ON CONFLICT collision with a soft-deleted row's id — that upsert still
   *  runs (and can overwrite that row's other columns with a stale client's
   *  values), but the delete flag itself is preserved either way. Reviving a
   *  deleted master row is only ever done deliberately, through masters.ts's
   *  own POST handler. */
  liveOnly?: any;
}
async function syncKeyed<T extends Record<string, unknown>>(
  tx: any,
  table: any,
  keyProp: string,
  rows: T[],
  opts: SyncKeyedOpts = {},
): Promise<void> {
  const size = opts.size ?? 400;
  const preserve = new Set(opts.preserveCols ?? []);
  const cols = getTableColumns(table);
  const keyCol = (cols as Record<string, any>)[keyProp];
  /* ON CONFLICT DO UPDATE, writing every non-key, non-preserved column from
     the row that was just proposed (`excluded`) — i.e. "if it exists, update
     it". */
  const set: Record<string, unknown> = {};
  for (const [prop, col] of Object.entries(cols as Record<string, any>)) {
    if (prop === keyProp || preserve.has(prop)) continue;
    set[prop] = sql`excluded.${sql.identifier(col.name)}`;
  }
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    if (slice.length) {
      await tx.insert(table).values(slice).onConflictDoUpdate({ target: keyCol, set });
    }
  }
  /* Prune: whatever the snapshot no longer contains is gone. Done by reading
     the stored keys and deleting the difference in bounded chunks rather than
     one huge NOT IN (...), so the statement can never blow past Postgres'
     bind-parameter limit on a large table. Scoped to liveOnly when given, so
     an already soft-deleted row is never in `stored` at all — it is not "no
     longer in the snapshot", it was never eligible to be compared in the
     first place, and must not be hard-deleted by this prune. */
  const keep = new Set(rows.map((r) => r[keyProp] as unknown));
  let storedQuery = tx.select({ k: keyCol }).from(table);
  if (opts.liveOnly) storedQuery = storedQuery.where(opts.liveOnly);
  const stored: Array<Record<string, unknown>> = await storedQuery;
  const drop = stored.map((r) => r.k).filter((k) => !keep.has(k));
  for (let i = 0; i < drop.length; i += size) {
    const slice = drop.slice(i, i + size);
    if (slice.length) await tx.delete(table).where(inArray(keyCol, slice as never[]));
  }
}
export async function replaceState(
  db: DB,
  s: StatePayload,
  actor?: JwtPayload,
): Promise<void> {
  const pendingGateOutNotifications: GateOutLineInput[] = [];
  const pendingGateInNotifications: GateInNotificationInput[] = [];
  await db.transaction(async (tx) => {
    /* Serialize whole-snapshot writes against each other. Two clients saving at
       the same moment (two browser tabs, or the page and its sync module) used
       to interleave their delete/insert passes and one of them died on a
       duplicate primary key — see syncKeyed() above. Taken as an *xact* lock,
       so it is released on COMMIT or ROLLBACK without any unlock bookkeeping.
       Concurrent savers queue for a moment instead of racing; reads
       (GET /api/state) never take this lock and are unaffected. */
    await tx.execute(sql`select pg_advisory_xact_lock(${STATE_WRITE_LOCK})`);

    // PDA PIN data (pinHash / pending email-reset OTP) and each employee's
    // own web-app login (username/passwordHash) never round-trip through the
    // legacy `S.employees` payload — the frontend that calls PUT /api/state
    // has no idea either exists. Capture both before the wipe below so every
    // employee save from the web app doesn't silently erase them.
    const pinById = new Map(
      (await tx
        .select({
          id: employees.id,
          pinHash: employees.pinHash,
          pinResetOtpHash: employees.pinResetOtpHash,
          pinResetExpiresAt: employees.pinResetExpiresAt,
          username: employees.username,
          passwordHash: employees.passwordHash,
          /* role_id is captured here for a second reason on top of "the blob
             doesn't carry it": it must never be taken FROM the blob. Anyone
             who can save state could otherwise hand themselves a Super Admin
             role by editing one number in the payload. Roles change only
             through PUT /api/roles/assign*, which checks permission.manage. */
          roleId: employees.roleId,
        })
        .from(employees)).map((r) => [r.id, r]),
    );

    /* 1) `events` is the one table still replaced wholesale: its rows carry no
       client-side key (the id is a serial, and the legacy UI treats S.events as
       an ordered array), so there is nothing to match an incoming row against.
       Everything else below goes through syncKeyed() — update what exists,
       insert what doesn't, delete what the snapshot dropped. audit_log is
       neither wiped nor synced; it is append-only (see section 9).
       `users` are untouched here, as before. */
    await tx.delete(events);

    // 2) config singleton (upsert id=1)
    const cfg = s.cfg ?? {};
    await tx
      .insert(config)
      .values({
        id: 1,
        agingDays: toInt(cfg.agingDays) ?? 15,
        boxValue: toNumStr(cfg.boxValue) ?? '450',
        lostMode: (cfg.lostMode as string) ?? 'manual',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: config.id,
        set: {
          agingDays: toInt(cfg.agingDays) ?? 15,
          boxValue: toNumStr(cfg.boxValue) ?? '450',
          lostMode: (cfg.lostMode as string) ?? 'manual',
          updatedAt: new Date(),
        },
      });

    // 3) sequences
    const seqRows = Object.entries(s.seq ?? {}).map(([name, value]) => ({
      name,
      value: toInt(value) ?? 0,
    }));
    await syncKeyed(tx, sequences, 'name', seqRows);

    // 4) boxes
    // Preserve webhook-owned LPR evidence when an already-open legacy page
    // posts its stale full-state snapshot back to the server.
    const persistedBoxes = new Map(
      (await tx.select({
        tag: boxes.tag,
        status: boxes.status,
        customer: boxes.customer,
        doNo: boxes.doNo,
        history: boxes.history,
      }).from(boxes))
        .map((row) => [row.tag, row]),
    );
    const boxRows = Object.entries(s.boxes ?? {}).map(([tag, raw]) => {
      const b = raw as Record<string, unknown>;
      const history = mergeLprHistory(b.history, persistedBoxes.get(tag)?.history);
      return {
        tag,
        type: (b.type as string) ?? null,
        value: toNumStr(b.value),
        status: (b.status as string) ?? 'pending',
        cycles: toInt(b.cycles) ?? 0,
        customer: (b.customer as string) ?? null,
        doNo: (b.do as string) ?? null,
        po: (b.po as string) ?? null,
        outGate: toInt(b.outGate),
        outWh: (b.outWh as string) ?? null,
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
        rfidTid: (b.rfidTid as string) ?? null,
        rfidEpc: (b.rfidEpc as string) ?? null,
        location: (b.location as object) ?? {},
        history,
        // composeState returns this blob to the browser. Keeping its history
        // aligned with the typed column is what makes the LPR panel update on
        // the next SSE-triggered state refresh.
        data: { ...b, history },
        updatedAt: new Date(),
      };
    });

    // The legacy Web App ships boxes by changing its full state snapshot,
    // rather than calling services/gate.ts. Detect the same warehouse→out
    // transition here so browser, PDA and fixed-reader flows all produce the
    // same automatic LINE side effect. Existing out rows and initial imports
    // are excluded, preventing a normal state re-save from notifying twice.
    const transitioned = new Map<string, { customerId: string; doNo: string; dueAt: Date; tags: string[]; plate: string }>();
    const returned = new Map<string, { customerId: string; doNo: string | null; receivedAt: Date; tags: string[]; plate: string }>();
    const historyPlate = (history: unknown): string => {
      if (!Array.isArray(history)) return '';
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const plate = String((history[i] as Record<string, unknown> | null)?.plate ?? '').trim();
        if (plate) return plate;
      }
      return '';
    };
    for (const row of boxRows) {
      const before = persistedBoxes.get(row.tag);
      if (!before) continue;
      if (before.status !== 'out' && row.status === 'out' && row.customer && row.dueAt) {
        const doNo = row.doNo ?? `WEB-${row.outAt?.getTime() ?? Date.now()}`;
        const key = `${row.customer}\n${doNo}\n${row.dueAt.toISOString()}`;
        const group = transitioned.get(key) ?? { customerId: row.customer, doNo, dueAt: row.dueAt, tags: [], plate: historyPlate(row.history) };
        group.tags.push(row.tag);
        transitioned.set(key, group);
      }
      if (before.status === 'out' && row.status !== 'out' && before.customer) {
        const receivedAt = row.lastSeenAt ?? new Date();
        const key = `${before.customer}\n${before.doNo ?? ''}\n${receivedAt.toISOString()}`;
        const group = returned.get(key) ?? {
          customerId: before.customer,
          doNo: before.doNo,
          receivedAt,
          tags: [],
          plate: historyPlate(before.history),
        };
        group.tags.push(row.tag);
        returned.set(key, group);
      }
    }
    await syncKeyed(tx, boxes, 'tag', boxRows);

    // 5) master data
    // LINE linking is written by the OAuth callback while an older browser
    // snapshot may still be open. Carry server-owned linkage/profile columns
    // forward when that stale snapshot contains an empty id; otherwise the
    // next unrelated save silently disconnects the customer. A new non-empty
    // id entered by an admin is still accepted. Deliberate unlinking uses the
    // dedicated DELETE /api/line/link/customers/:id route.
    const persistedCustomerLine = new Map(
      (await tx.select({
        id: customers.id,
        lineUserId: customers.lineUserId,
        lineDisplayName: customers.lineDisplayName,
        linePictureUrl: customers.linePictureUrl,
        lineLinkedAt: customers.lineLinkedAt,
      }).from(customers)).map((row) => [row.id, row]),
    );
    await syncKeyed(
      tx,
      customers,
      'id',
      Object.entries(s.customers ?? {}).map(([id, raw]) => {
        const c = raw as Record<string, unknown>;
        const persisted = persistedCustomerLine.get(id);
        const incomingLineUserId = String(c.lineUserId ?? '').trim();
        const persistedLineUserId = String(persisted?.lineUserId ?? '').trim();
        // A stale UI has historically carried LINE usernames/basic IDs in
        // this field. Only a real Messaging API user id may replace the OAuth
        // value; invalid non-empty text must not disconnect a linked account.
        const lineUserId = LINE_USER_ID.test(incomingLineUserId)
          ? incomingLineUserId
          : LINE_USER_ID.test(persistedLineUserId)
            ? persistedLineUserId
            : null;
        return {
          id,
          name: (c.name as string) ?? null,
          addr: (c.addr as string) ?? null,
          contact: (c.contact as string) ?? null,
          lineUserId,
          lineDisplayName: persisted?.lineDisplayName ?? null,
          linePictureUrl: persisted?.linePictureUrl ?? null,
          lineLinkedAt: persisted?.lineLinkedAt ?? null,
          contactEmail: ((c.contactEmail ?? c.email) as string) ?? null,
          returnDays: toInt(c.returnDays),
          data: lineUserId ? { ...c, lineUserId } : c,
          updatedAt: new Date(),
        };
      }),
      { preserveCols: ['deletedAt'], liveOnly: isNull(customers.deletedAt) },
    );

    if (transitioned.size || returned.size) {
      const customerRows = new Map(
        (await tx.select({
          id: customers.id,
          name: customers.name,
          lineUserId: customers.lineUserId,
          contactEmail: customers.contactEmail,
        }).from(customers))
          .map((row) => [row.id, row]),
      );
      for (const group of transitioned.values()) {
        const customer = customerRows.get(group.customerId);
        pendingGateOutNotifications.push({
          customerId: group.customerId,
          customerName: customer?.name ?? group.customerId,
          lineUserId: customer?.lineUserId ?? null,
          contactEmail: customer?.contactEmail ?? null,
          doNo: group.doNo,
          tags: group.tags,
          dueAt: group.dueAt.toISOString(),
          plate: group.plate,
        });
      }
      for (const group of returned.values()) {
        const customer = customerRows.get(group.customerId);
        pendingGateInNotifications.push({
          customerId: group.customerId,
          customerName: customer?.name ?? group.customerId,
          lineUserId: customer?.lineUserId ?? null,
          contactEmail: customer?.contactEmail ?? null,
          doNo: group.doNo,
          tags: group.tags,
          receivedAt: group.receivedAt.toISOString(),
          plate: group.plate,
        });
      }
    }

    await syncKeyed(
      tx,
      boxTypes,
      'id',
      Object.entries(s.boxtypes ?? {}).map(([id, raw]) => {
        const t = raw as Record<string, unknown>;
        return {
          id,
          name: (t.name as string) ?? null,
          unit: (t.unit as string) ?? null,
          value: toNumStr(t.value),
          dim: (t.dim as string) ?? null,
          data: t,
          updatedAt: new Date(),
        };
      }),
      { preserveCols: ['deletedAt'], liveOnly: isNull(boxTypes.deletedAt) },
    );

    const persistedWarehouseModes = new Map(
      (await tx.select({ id: warehouses.id, data: warehouses.data }).from(warehouses))
        .map((row) => [row.id, (row.data as Record<string, unknown>)?.gateBidirectionalModes]),
    );
    await syncKeyed(
      tx,
      warehouses,
      'id',
      Object.entries(s.warehouses ?? {}).map(([id, raw]) => {
        const w = raw as Record<string, unknown>;
        const persistedModes = persistedWarehouseModes.get(id);
        const hasIncomingModes = Object.prototype.hasOwnProperty.call(w, 'gateBidirectionalModes');
        const gateBidirectionalModes = !hasIncomingModes && persistedModes && typeof persistedModes === 'object'
          ? persistedModes : w.gateBidirectionalModes;
        return {
          id,
          name: (w.name as string) ?? null,
          gateType: (w.gateType as string) ?? null,
          gates: (w.gates as unknown[]) ?? [],
          gateTypes: (w.gateTypes as object) ?? {},
          /* gateBidirectionalModes is maintained by the RFID configuration
             API. Preserve the server-side value when an older browser sends a
             stale /api/state snapshot, otherwise a live page can silently
             turn a configured two-antenna gate back into screen mode. */
          data: !hasIncomingModes && gateBidirectionalModes
            ? { ...w, gateBidirectionalModes } : w,
          updatedAt: new Date(),
        };
      }),
    );

    await syncKeyed(
      tx,
      locations,
      'code',
      Object.entries(s.locations ?? {}).map(([code, raw]) => {
        const l = raw as Record<string, unknown>;
        return {
          code,
          wh: (l.wh as string) ?? null,
          zone: (l.zone as string) ?? null,
          rack: (l.rack as string) ?? null,
          shelf: (l.shelf as string) ?? null,
          slot: (l.slot as string) ?? null,
          type: (l.type as string) ?? null,
          note: (l.note as string) ?? null,
          data: l,
          updatedAt: new Date(),
        };
      }),
    );

    /* Bootstrap self-registration: the legacy UI's "ลงทะเบียนผู้ใช้งานคนแรก"
       modal (opened client-side whenever S.employees comes back empty) tells
       the operator they'll "automatically get Admin access" — but the modal
       never collects a password, and this endpoint had no notion of linking
       the employee row it creates to any `users` account at all. The result
       was a real employee record with name/phone/email saved correctly, but
       userId/username/passwordHash all left null, so that person could never
       actually log in as themselves — only the request's own already-
       authenticated account (bootstrapped from the seed admin) could reach
       this endpoint at all (requireRole('admin','staff') above), and that's
       exactly the account this bootstrap employee is standing in for. Link
       them to it: only when the employees table was genuinely empty before
       this write (pinById, captured pre-wipe above, is the "before" state),
       the caller authenticated via a `users` row (not an employee login —
       employeeId is only set on the latter, see JwtPayload), and the
       incoming row doesn't already carry an explicit userId of its own.
       Also requires exactly one incoming employee — an empty table plus a
       multi-row batch import (Master ▸ Excel) landing in the same instant
       is a real possibility and must NOT link every imported employee to
       whichever admin happened to run the import. */
    const incomingEmployeeCount = Object.keys(s.employees ?? {}).length;
    const bootstrapUserId =
      pinById.size === 0 &&
      incomingEmployeeCount === 1 &&
      actor &&
      actor.employeeId === undefined
        ? toInt(actor.sub)
        : null;

    await syncKeyed(
      tx,
      employees,
      'id',
      Object.entries(s.employees ?? {}).map(([id, raw]) => {
        const e = raw as Record<string, unknown>;
        const pin = pinById.get(id);
        return {
          id,
          name: (e.name as string) ?? null,
          role: (e.role as string) ?? null,
          /* This table is wiped and fully reinserted on every save() — userId
             is a typed column, not part of `data`, so it must be carried over
             explicitly here or the account link set via PATCH /link would be
             silently dropped on the very next unrelated state save. Same
             reasoning for the PIN/login columns, captured into pinById above
             since they never round-trip through `data` at all (see composeState). */
          userId: toInt(e.userId) ?? bootstrapUserId,
          /* roleId is deliberately omitted: role assignment has its own API and
             must never be overwritten by a stale whole-state snapshot. */
          data: e,
          pinHash: pin?.pinHash ?? null,
          pinResetOtpHash: pin?.pinResetOtpHash ?? null,
          pinResetExpiresAt: pin?.pinResetExpiresAt ?? null,
          username: pin?.username ?? null,
          passwordHash: pin?.passwordHash ?? null,
          updatedAt: new Date(),
        };
      }),
      { preserveCols: ['roleId'] },
    );

    // 6) simple keyed maps
    for (const [tbl, map] of [
      [vehicles, s.vehicles],
      [doRecords, s.doRecords],
      [putaway, s.putaway],
      [inventory, s.inventory],
    ] as const) {
      await syncKeyed(
        tx,
        tbl,
        'id',
        Object.entries(map ?? {}).map(([id, raw]) => ({ id, data: raw, updatedAt: new Date() })),
      );
    }

    // 7) gates lookup (gate# → warehouseId)
    await syncKeyed(
      tx,
      gates,
      'gateNo',
      Object.entries(s.gates ?? {})
        .map(([g, wh]) => ({ gateNo: toInt(g)!, warehouseId: (wh as string) ?? null }))
        .filter((r) => r.gateNo !== null),
    );

    // 8) event stream (preserve array order → serial id order)
    await chunkInsert(
      tx,
      events,
      (s.events ?? []).map((e) => {
        const ev = e as Record<string, unknown>;
        return { ts: toDate(ev.ts) ?? new Date(), data: ev };
      }),
    );

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
    const auditKey = (ts: Date, action: string | null, entityId: string | null, actor: string | null) =>
      `${ts.toISOString()}|${action}|${entityId}|${actor}`;
    const existingAuditKeys = new Set(
      existingAuditRows.map((r: { ts: Date; action: string | null; entityId: string | null; actor: string | null }) =>
        auditKey(r.ts, r.action, r.entityId, r.actor),
      ),
    );
    const isHumanAuditEntry = (entry: Record<string, unknown>) => {
      const actor = String(entry.recorder ?? '').trim();
      const action = String(entry.action ?? '').toLowerCase();
      const timestamp = toDate(entry.ts);
      // Device/webhook/heartbeat events are telemetry, not human actions.
      return !!timestamp && timestamp >= AUDIT_CACHE_CUTOFF && actor !== '' && action !== ''
        && !/^(system|auto|fx9600|lpr)/i.test(actor)
        && !/(heartbeat|webhook|lpr|rfid_read|auto_)/i.test(action)
        && isEmployeeCrudAuditEntry(entry);
    };
    const newAuditRows = (s.auditLog ?? [])
      .filter((a) => isHumanAuditEntry(a as Record<string, unknown>))
      .map((a) => {
        const e = a as Record<string, unknown>;
        return {
          action: (e.action as string) ?? null,
          actor: (e.recorder as string) ?? null,
          entityId: (e.itemId as string) ?? null,
          entityName: (e.itemName as string) ?? null,
          before: (e.before as object) ?? null,
          after: (e.after as object) ?? null,
          data: e,
          ts: toDate(e.ts) ?? new Date(),
        };
      })
      .filter((r) => !existingAuditKeys.has(auditKey(r.ts, r.action, r.entityId, r.actor)));
    await chunkInsert(tx, auditLog, newAuditRows);
  });

  // Commit stock first. LINE errors are persisted in the durable outbox and
  // retried independently; they must never roll back a completed Gate Out.
  for (const notification of pendingGateOutNotifications) {
    await sendGateOutLineNotification(db, notification);
  }
  for (const notification of pendingGateInNotifications) {
    await sendGateInNotifications(db, notification);
  }
}

/** Insert in bounded chunks to stay well under Postgres' bind-parameter limit. */
async function chunkInsert(tx: any, table: any, rows: any[], size = 400): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    if (slice.length) await tx.insert(table).values(slice);
  }
}
