let version = 0;
const listeners = new Set();
/** Record that state changed and notify every open stream. */
export function bump(origin) {
    version += 1;
    const from = origin || null;
    for (const listener of listeners) {
        // One bad subscriber must not stop the others from being told.
        try {
            listener(version, from);
        }
        catch {
            /* a dead response stream throws on write; its own close handler unsubscribes it */
        }
    }
    return version;
}
/** Listen for changes. Returns the unsubscribe function. */
export function subscribe(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export const currentVersion = () => version;
export const subscriberCount = () => listeners.size;
//# sourceMappingURL=bus.js.map