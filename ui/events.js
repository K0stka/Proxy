const eventTypes = ['state', 'logs', 'alerts', 'security', 'notifications'];
const listeners = new Map(eventTypes.map((type) => [type, new Set()]));
const refreshTimers = new Map();
let source;

export function subscribeUpdates(listener, type = 'state') {
  const callbacks = listeners.get(type);
  if (!callbacks) throw new Error(`Unknown update event: ${type}`);
  callbacks.add(listener);
  if (!source) {
    source = new EventSource('/api/events');
    for (const [eventType, listenersForType] of listeners) source.addEventListener(eventType, () => {
      if (refreshTimers.has(eventType)) return;
      refreshTimers.set(eventType, setTimeout(() => {
        refreshTimers.delete(eventType);
        listenersForType.forEach((callback) => callback());
      }, 300));
    });
  }
  return () => {
    callbacks.delete(listener);
    if (![...listeners.values()].some((current) => current.size)) {
      source?.close(); source = null;
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
    }
  };
}
