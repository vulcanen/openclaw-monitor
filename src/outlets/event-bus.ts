import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

export type BusEvent = {
  capturedAt: number;
  event: DiagnosticEventPayload;
};

export type BusListener = (evt: BusEvent) => void;

export type EventBus = {
  publish: (evt: BusEvent) => void;
  subscribe: (listener: BusListener) => () => void;
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
    if (listeners.size >= max) {
      // refuse silently; caller checks size before subscribing for HTTP 503
      return () => {};
    }
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
