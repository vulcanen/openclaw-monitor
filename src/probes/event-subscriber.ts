import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { Aggregator } from "../pipeline/aggregator.js";
import type { RunsTracker } from "../pipeline/runs-tracker.js";
import type { StoreRef } from "../storage/store-ref.js";
import type { EventBuffer } from "../storage/ring-buffer.js";
import type { EventBus } from "../outlets/event-bus.js";

export type EventFanout = {
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
  inject: (event: DiagnosticEventPayload, capturedAtMs?: number) => void;
};

export type EventFanoutDeps = {
  buffer: EventBuffer;
  bus: EventBus;
  storeRef: StoreRef;
  aggregator: Aggregator;
  runsTracker: RunsTracker;
};

export function createEventFanout(deps: EventFanoutDeps): EventFanout {
  let unsubscribe: (() => void) | undefined;

  const dispatch = (event: DiagnosticEventPayload, capturedAt: number): void => {
    try {
      deps.buffer.append(event);
    } catch {
      // never throw back into host dispatcher
    }
    try {
      deps.aggregator.ingest(event, capturedAt);
    } catch {
      // ignore
    }
    try {
      const finalSnap = deps.runsTracker.ingest(event, capturedAt);
      if (finalSnap) {
        try {
          deps.storeRef.get()?.appendRun(finalSnap);
        } catch {
          // best-effort persistence
        }
      }
    } catch {
      // ignore
    }
    try {
      deps.storeRef.get()?.appendEvent(event, capturedAt);
    } catch {
      // best-effort persistence
    }
    try {
      deps.bus.publish({ event, capturedAt });
    } catch {
      // ignore
    }
  };

  const start: EventFanout["start"] = () => {
    if (unsubscribe) return;
    unsubscribe = onDiagnosticEvent((event) => {
      dispatch(event, Date.now());
    });
  };

  const stop: EventFanout["stop"] = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  const isActive: EventFanout["isActive"] = () => unsubscribe !== undefined;

  const inject: EventFanout["inject"] = (event, capturedAtMs) => {
    dispatch(event, capturedAtMs ?? Date.now());
  };

  return { start, stop, isActive, inject };
}
