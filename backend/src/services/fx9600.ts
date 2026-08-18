/**
 * FX9600 fixed-reader liveness.
 *
 * The reader itself must be configured to POST to `/api/fx9600/webhook` on
 * every inventory cycle — including cycles where it read zero tags. That's a
 * setting on the reader ("Report No Read" / keepalive interval in its own
 * HTTP POST Notification config), not something this backend controls; all
 * this module can do is treat "no webhook arrived recently" as offline.
 *
 * Online/offline is derived purely from `lastWebhookAt` recency, never from
 * tag activity — a reader sitting in an empty gate with nothing to see is
 * still online as long as it keeps calling in.
 */
import type { DB } from '../db/client.js';
import { fx9600Readers } from '../db/schema.js';
import { broadcastReaderStatuses, type ReaderStatus } from '../lib/readerBus.js';

/** How long without a webhook before a reader is considered offline. Short by
 *  design — this is a LAN-local heartbeat, not an internet round trip — but
 *  must stay comfortably above the reader's own report interval or every
 *  reader will flap offline between its own heartbeats. */
export const OFFLINE_THRESHOLD_MS = 5_000;

/** How often the watchdog re-checks recency and pushes updates to clients. */
const WATCHDOG_INTERVAL_MS = 1_000;

function toStatus(row: typeof fx9600Readers.$inferSelect, now: number): ReaderStatus {
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
export async function touchReader(
  db: DB,
  readerId: string,
  gateNo: number | null,
  payload: unknown,
): Promise<void> {
  const now = new Date();
  await db
    .insert(fx9600Readers)
    .values({
      id: readerId,
      gateNo,
      lastWebhookAt: now,
      lastPayload: (payload ?? {}) as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: fx9600Readers.id,
      set: {
        lastWebhookAt: now,
        ...(gateNo !== null ? { gateNo } : {}),
        lastPayload: (payload ?? {}) as Record<string, unknown>,
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

export async function getReaderStatuses(db: DB): Promise<ReaderStatus[]> {
  const rows = await db.select().from(fx9600Readers);
  const now = Date.now();
  return rows.map((r) => toStatus(r, now));
}

/* Cache of each reader's online bit as of the last watchdog tick, so the
 * watchdog only broadcasts (and only wakes idle SSE connections) when a
 * status actually flips rather than once a second regardless. */
let lastKnown = new Map<string, boolean>();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function statusesChanged(statuses: ReaderStatus[]): boolean {
  if (statuses.length !== lastKnown.size) return true;
  for (const s of statuses) {
    if (lastKnown.get(s.id) !== s.online) return true;
  }
  return false;
}

/** Start the 1s recency check that flips readers to offline the moment they
 *  go quiet, without waiting for the next webhook to prove they're gone. */
export function startFx9600Watchdog(db: DB): () => void {
  if (watchdogTimer) return () => {};
  watchdogTimer = setInterval(async () => {
    const statuses = await getReaderStatuses(db);
    if (!statusesChanged(statuses)) return;
    lastKnown = new Map(statuses.map((s) => [s.id, s.online]));
    broadcastReaderStatuses(statuses);
  }, WATCHDOG_INTERVAL_MS);
  return () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  };
}
