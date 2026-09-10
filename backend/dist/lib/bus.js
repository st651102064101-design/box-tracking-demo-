let version = 0;
const listeners = new Set();
const rfidReadListeners = new Set();
const readerStatusListeners = new Set();
const lprDetectionListeners = new Set();
const forkliftStateListeners = new Set();
/** Record that state changed and notify every open stream. */
export function bump(origin, scope = 'state') {
    version += 1;
    const event = { version, origin: origin || null, scope };
    for (const listener of listeners) {
        // One bad subscriber must not stop the others from being told.
        try {
            listener(event);
        }
        catch {
            /* a dead response stream throws on write; its own close handler unsubscribes it */
        }
    }
    return version;
}
/** Deliver a committed PostgreSQL change to the same SSE fan-out as API writes. */
export function bumpFromDatabase(scope = 'warehouse3d') {
    return bump(null, scope);
}
/** Listen for changes. Returns the unsubscribe function. */
export function subscribe(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
/** Publish a tag-read delta without forcing every browser to reload /api/state. */
export function publishRfidRead(gate, tags, movement) {
    const event = {
        id: `${gate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        gate,
        tags: Array.from(new Set(tags)),
        ...movement,
        ts: new Date().toISOString(),
    };
    for (const listener of rfidReadListeners) {
        try {
            listener(event);
        }
        catch { /* dead stream removes itself on close */ }
    }
    return event;
}
export function subscribeRfidRead(listener) {
    rfidReadListeners.add(listener);
    return () => rfidReadListeners.delete(listener);
}
/** Publish the lightweight liveness delta produced by every accepted reader webhook. */
export function publishReaderStatus(input) {
    const event = {
        ...input,
        id: `${input.readerId ?? `gate-${input.gate}`}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        online: true,
    };
    for (const listener of readerStatusListeners) {
        try {
            listener(event);
        }
        catch { /* dead stream removes itself on close */ }
    }
    return event;
}
export function subscribeReaderStatus(listener) {
    readerStatusListeners.add(listener);
    return () => readerStatusListeners.delete(listener);
}
export function publishLprDetection(input) {
    const event = { ...input, id: `lpr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    for (const listener of lprDetectionListeners) {
        try {
            listener(event);
        }
        catch { /* dead stream */ }
    }
    return event;
}
export function subscribeLprDetection(listener) {
    lprDetectionListeners.add(listener);
    return () => lprDetectionListeners.delete(listener);
}
/**
 * Publish the small, high-frequency forklift delta separately from `bump()`.
 * A generic state event makes every legacy browser download and reconcile the
 * complete application snapshot; doing that for 20 movement frames a second
 * both wastes bandwidth and makes spectator animation visibly stutter.
 */
export function publishForkliftState(event) {
    for (const listener of forkliftStateListeners) {
        try {
            listener(event);
        }
        catch { /* dead stream removes itself on close */ }
    }
    return event;
}
export function subscribeForkliftState(listener) {
    forkliftStateListeners.add(listener);
    return () => forkliftStateListeners.delete(listener);
}
export const currentVersion = () => version;
export const subscriberCount = () => listeners.size;
//# sourceMappingURL=bus.js.map