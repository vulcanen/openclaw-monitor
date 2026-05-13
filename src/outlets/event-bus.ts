import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

export type BusEvent = {
  capturedAt: number;
  event: DiagnosticEventPayload;
};

export type BusListener = (evt: BusEvent) => void;

export type EventBus = {
  publish: (evt: BusEvent) => void;
  /**
   * Adds `listener` and returns an unsubscribe function — UNLESS the bus is
   * already at capacity, in which case it returns `undefined`. Callers
   * (SSE stream handler) MUST treat `undefined` as "refused" and end the
   * response with 503 instead of holding the socket open with no listener
   * attached.
   *
   * Why this shape: a prior version had `size()` + `subscribe()` as two
   * separate calls, but concurrent requests could both pass the size check
   * and only one would actually be added — the loser silently got a no-op
   * `unsubscribe` and an open socket that received zero events. Atomic
   * check-and-add closes the race.
   */
  subscribe: (listener: BusListener) => (() => void) | undefined;
  size: () => number;
  reset: () => void;
};

export function createEventBus(opts: { maxListeners: number }): EventBus {
  const listeners = new Set<BusListener>();
  const max = Math.max(1, Math.floor(opts.maxListeners));

  const publish: EventBus["publish"] = (evt) => {
    for (const listener of listeners) {
      try {
        listener(evt);
      } catch {
        // listener bugs must not break the bus
      }
    }
  };

  const subscribe: EventBus["subscribe"] = (listener) => {
    if (listeners.size >= max) return undefined;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const size: EventBus["size"] = () => listeners.size;

  const reset: EventBus["reset"] = () => {
    listeners.clear();
  };

  return { publish, subscribe, size, reset };
}
