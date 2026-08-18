/**
 * In-process pub/sub for FX9600 reader online/offline status — a sibling to
 * `bus.ts` but deliberately separate from it. `bus.ts` carries "warehouse
 * state changed, go re-fetch /api/state"; this carries the actual reader
 * status snapshot, because there's no equivalent full-state endpoint for
 * readers to re-fetch from and the payload is tiny anyway. Same per-process
 * caveat as bus.ts: a multi-replica deployment would need this moved to
 * Postgres LISTEN/NOTIFY.
 */
export type ReaderStatus = {
  id: string;
  gateNo: number | null;
  online: boolean;
  lastWebhookAt: string | null;
};

export type ReaderStatusListener = (statuses: ReaderStatus[]) => void;

const listeners = new Set<ReaderStatusListener>();

/** Push the current status of every known reader to every open stream. */
export function broadcastReaderStatuses(statuses: ReaderStatus[]): void {
  for (const listener of listeners) {
    try {
      listener(statuses);
    } catch {
      /* a dead response stream throws on write; its own close handler unsubscribes it */
    }
  }
}

export function subscribeReaderStatuses(listener: ReaderStatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
