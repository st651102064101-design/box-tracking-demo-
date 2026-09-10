const listeners = new Set();
/** Push the current status of every known reader to every open stream. */
export function broadcastReaderStatuses(statuses) {
    for (const listener of listeners) {
        try {
            listener(statuses);
        }
        catch {
            /* a dead response stream throws on write; its own close handler unsubscribes it */
        }
    }
}
export function subscribeReaderStatuses(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
//# sourceMappingURL=readerBus.js.map