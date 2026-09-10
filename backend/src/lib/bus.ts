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
export type StateChangeScope = 'state' | 'warehouse3d';
export type StateChangeEvent = {
  version: number;
  origin: string | null;
  /**
   * `warehouse3d` is used for physical-layout writes which are not represented
   * in `/api/state` (racks and slots).  It tells a mounted renderer to reload
   * even when the legacy-state signature is unchanged.
   */
  scope: StateChangeScope;
};
export type ChangeListener = (event: StateChangeEvent) => void;
export type RfidReadEvent = { id: string; gate: number; tags: string[]; inbound?: string[]; outbound?: string[]; antennas?: number[]; decoded?: string[]; unknown?: string[]; repeats?: string[]; ts: string };
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
export type LprDetectionEvent = { id: string; eventId: string; gateId: string; plateNumber: string; confidence: number; rfidTags: string[]; ts: string };
export type LprDetectionListener = (event: LprDetectionEvent) => void;
export type ForkliftStateEvent = {
  warehouseId: string;
  forkliftId: string;
  position: { x: number; y: number; z: number };
  rotationY: number;
  target: { x: number; y: number; z: number } | null;
  liftHeight: number;
  cargoBoxId: string | null;
  moving: boolean;
  layoutRevision: string | null;
  updatedAt: string;
  origin: string | null;
};
export type ForkliftStateListener = (event: ForkliftStateEvent) => void;
export type Warehouse3dSettingsEvent = {
  warehouseId: string;
  settings: Record<string, boolean>;
  origin: string | null;
  updatedAt: string;
};
export type Warehouse3dSettingsListener = (event: Warehouse3dSettingsEvent) => void;

let version = 0;
const listeners = new Set<ChangeListener>();
const rfidReadListeners = new Set<RfidReadListener>();
const readerStatusListeners = new Set<ReaderStatusListener>();
const lprDetectionListeners = new Set<LprDetectionListener>();
const forkliftStateListeners = new Set<ForkliftStateListener>();
const warehouse3dSettingsListeners = new Set<Warehouse3dSettingsListener>();

/** Record that state changed and notify every open stream. */
export function bump(origin?: string | null, scope: StateChangeScope = 'state'): number {
  version += 1;
  const event: StateChangeEvent = { version, origin: origin || null, scope };
  for (const listener of listeners) {
    // One bad subscriber must not stop the others from being told.
    try {
      listener(event);
    } catch {
      /* a dead response stream throws on write; its own close handler unsubscribes it */
    }
  }
  return version;
}

/** Deliver a committed PostgreSQL change to the same SSE fan-out as API writes. */
export function bumpFromDatabase(scope: StateChangeScope = 'warehouse3d'): number {
  return bump(null, scope);
}

/** Listen for changes. Returns the unsubscribe function. */
export function subscribe(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish a tag-read delta without forcing every browser to reload /api/state. */
export function publishRfidRead(gate: number, tags: string[], movement?: { inbound?: string[]; outbound?: string[]; antennas?: number[]; decoded?: string[]; unknown?: string[]; repeats?: string[] }): RfidReadEvent {
  const event = {
    id: `${gate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    gate,
    tags: Array.from(new Set(tags)),
    ...movement,
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

export function publishLprDetection(input: Omit<LprDetectionEvent, 'id'>): LprDetectionEvent {
  const event = { ...input, id: `lpr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  for (const listener of lprDetectionListeners) {
    try { listener(event); } catch { /* dead stream */ }
  }
  return event;
}
export function subscribeLprDetection(listener: LprDetectionListener): () => void {
  lprDetectionListeners.add(listener);
  return () => lprDetectionListeners.delete(listener);
}

/**
 * Publish the small, high-frequency forklift delta separately from `bump()`.
 * A generic state event makes every legacy browser download and reconcile the
 * complete application snapshot; doing that for 20 movement frames a second
 * both wastes bandwidth and makes spectator animation visibly stutter.
 */
export function publishForkliftState(event: ForkliftStateEvent): ForkliftStateEvent {
  for (const listener of forkliftStateListeners) {
    try { listener(event); } catch { /* dead stream removes itself on close */ }
  }
  return event;
}

export function subscribeForkliftState(listener: ForkliftStateListener): () => void {
  forkliftStateListeners.add(listener);
  return () => forkliftStateListeners.delete(listener);
}

/** View controls are a small shared delta. Keep them off the generic state
 * channel so changing a grid/roof never reloads or remounts the 3D scene. */
export function publishWarehouse3dSettings(event: Warehouse3dSettingsEvent): Warehouse3dSettingsEvent {
  for (const listener of warehouse3dSettingsListeners) {
    try { listener(event); } catch { /* dead stream removes itself on close */ }
  }
  return event;
}

export function subscribeWarehouse3dSettings(listener: Warehouse3dSettingsListener): () => void {
  warehouse3dSettingsListeners.add(listener);
  return () => warehouse3dSettingsListeners.delete(listener);
}

export const currentVersion = () => version;
export const subscriberCount = () => listeners.size;
