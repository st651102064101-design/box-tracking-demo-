import { fx9600Readers } from '../db/schema.js';
import { broadcastReaderStatuses } from '../lib/readerBus.js';
/** How long without a webhook before a reader is considered offline. Short by
 *  design — this is a LAN-local heartbeat, not an internet round trip — but
 *  must stay comfortably above the reader's own report interval or every
 *  reader will flap offline between its own heartbeats. */
export const OFFLINE_THRESHOLD_MS = 5_000;
/** How often the watchdog re-checks recency and pushes updates to clients. */
const WATCHDOG_INTERVAL_MS = 1_000;
function toStatus(row, now) {
    const last = row.lastWebhookAt ? new Date(row.lastWebhookAt).getTime() : null;
    return {
        id: row.id,
        gateNo: row.gateNo ?? null,
        online: last !== null && now - last <= OFFLINE_THRESHOLD_MS,
        lastWebhookAt: row.lastWebhookAt ? new Date(row.lastWebhookAt).toISOString() : null,
    };
}
/** Record an inbound webhook call — a tag read or an empty "no read" ping,
 *  both count identically as proof of life. */
export async function touchReader(db, readerId, gateNo, payload) {
    const now = new Date();
    await db
        .insert(fx9600Readers)
        .values({
        id: readerId,
        gateNo,
        lastWebhookAt: now,
        lastPayload: (payload ?? {}),
    })
        .onConflictDoUpdate({
        target: fx9600Readers.id,
        set: {
            lastWebhookAt: now,
            ...(gateNo !== null ? { gateNo } : {}),
            lastPayload: (payload ?? {}),
        },
    });
    /* Push the online flip immediately rather than waiting up to
       WATCHDOG_INTERVAL_MS for the next tick — a reader coming back online
       should show up the instant its first webhook lands. */
    if (lastKnown.get(readerId) !== true) {
        lastKnown.set(readerId, true);
        broadcastReaderStatuses(await getReaderStatuses(db));
    }
}
export async function getReaderStatuses(db) {
    const rows = await db.select().from(fx9600Readers);
    const now = Date.now();
    return rows.map((r) => toStatus(r, now));
}
/* Cache of each reader's online bit as of the last watchdog tick, so the
 * watchdog only broadcasts (and only wakes idle SSE connections) when a
 * status actually flips rather than once a second regardless. */
let lastKnown = new Map();
let watchdogTimer = null;
function statusesChanged(statuses) {
    if (statuses.length !== lastKnown.size)
        return true;
    for (const s of statuses) {
        if (lastKnown.get(s.id) !== s.online)
            return true;
    }
    return false;
}
/** Start the 1s recency check that flips readers to offline the moment they
 *  go quiet, without waiting for the next webhook to prove they're gone. */
export function startFx9600Watchdog(db) {
    if (watchdogTimer)
        return () => { };
    watchdogTimer = setInterval(async () => {
        const statuses = await getReaderStatuses(db);
        if (!statusesChanged(statuses))
            return;
        lastKnown = new Map(statuses.map((s) => [s.id, s.online]));
        broadcastReaderStatuses(statuses);
    }, WATCHDOG_INTERVAL_MS);
    return () => {
        if (watchdogTimer)
            clearInterval(watchdogTimer);
        watchdogTimer = null;
    };
}
//# sourceMappingURL=fx9600.js.map