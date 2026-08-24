/**
 * In-process change bus.
 *
 * Every write to warehouse state bumps a counter and tells whoever is listening.
 * Browsers hold an SSE connection (see routes/stream.ts) and use the ping as a
 * cue to re-read `/api/state` — that keeps this module free of any knowledge of
 * what actually changed, which matters because `PUT /api/state` replaces the
 * whole snapshot and could not describe a delta even if we wanted one.
 *
 * `origin` carries the id of the client that caused the change, so that client
 * can ignore the echo of its own write instead of re-fetching what it just sent.
 *
 * This is deliberately per-process. The app runs as a single API container, so
 * a shared bus would be a database round-trip for no benefit. Running more than
 * one replica would need this moved to Postgres LISTEN/NOTIFY — the subscriber
 * interface below is the seam where that swap happens.
 */
export type ChangeListener = (version: number, origin: string | null) => void;
export type RfidReadEvent = { id: string; gate: number; tags: string[]; ts: string };
export type RfidReadListener = (event: RfidReadEvent) => void;
export type ReaderStatusEvent = {
  id: string;
  readerId: string | null;
  host: string | null;
  sourceIp: string | null;
  gate: number;
  online: true;
  lastActiveAt: string;
};
export type ReaderStatusListener = (event: ReaderStatusEvent) => void;

let version = 0;
const listeners = new Set<ChangeListener>();
const rfidReadListeners = new Set<RfidReadListener>();
const readerStatusListeners = new Set<ReaderStatusListener>();

/** Record that state changed and notify every open stream. */
export function bump(origin?: string | null): number {
  version += 1;
  const from = origin || null;
  for (const listener of listeners) {
    // One bad subscriber must not stop the others from being told.
    try {
      listener(version, from);
    } catch {
      /* a dead response stream throws on write; its own close handler unsubscribes it */
    }
  }
  return version;
}

/** Listen for changes. Returns the unsubscribe function. */
export function subscribe(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish a tag-read delta without forcing every browser to reload /api/state. */
export function publishRfidRead(gate: number, tags: string[]): RfidReadEvent {
  const event = {
    id: `${gate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    gate,
    tags: Array.from(new Set(tags)),
    ts: new Date().toISOString(),
  };
  for (const listener of rfidReadListeners) {
    try { listener(event); } catch { /* dead stream removes itself on close */ }
  }
  return event;
}

export function subscribeRfidRead(listener: RfidReadListener): () => void {
  rfidReadListeners.add(listener);
  return () => rfidReadListeners.delete(listener);
}

/** Publish the lightweight liveness delta produced by every accepted reader webhook. */
export function publishReaderStatus(input: Omit<ReaderStatusEvent, 'id' | 'online'>): ReaderStatusEvent {
  const event: ReaderStatusEvent = {
    ...input,
    id: `${input.readerId ?? `gate-${input.gate}`}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    online: true,
  };
  for (const listener of readerStatusListeners) {
    try { listener(event); } catch { /* dead stream removes itself on close */ }
  }
  return event;
}

export function subscribeReaderStatus(listener: ReaderStatusListener): () => void {
  readerStatusListeners.add(listener);
  return () => readerStatusListeners.delete(listener);
}

export const currentVersion = () => version;
export const subscriberCount = () => listeners.size;
