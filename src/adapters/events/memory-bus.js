// EventBus adapter for a single instance. Events reach the browser over SSE.
// With more than one instance, replace with Redis pub/sub or Postgres
// LISTEN/NOTIFY; the outbox rows in the store make that switch lossless.

export function createMemoryBus() {
  const listeners = new Set();
  return {
    publish(event) {
      for (const l of listeners) {
        if (l.filter(event)) {
          try { l.fn(event); } catch (err) { console.error('[bus] listener failed:', err.message); }
        }
      }
    },
    subscribe(filter, fn) {
      const l = { filter, fn };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    size: () => listeners.size,
  };
}
