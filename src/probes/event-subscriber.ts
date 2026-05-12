import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { ConversationProbe } from "../audit/conversation-probe.js";
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
  conversationProbe: ConversationProbe;
  /**
   * Optional: when set, every `llm.tokens.recorded` event passed through
   * the fanout is also folded into the calendar-day persistent rollup so
   * today/week/month totals survive restarts. Wired in v0.8.0.
   */
  dailyCostStoreRef?: import("../costs/store-ref.js").DailyCostStoreRef;
};

export function createEventFanout(deps: EventFanoutDeps): EventFanout {
  let unsubscribe: (() => void) | undefined;
  // Dedup ring for synthesized vs natural events. If the host emits BOTH a
  // diagnostic event and the matching hook for the same call, the second
  // arrival is dropped. Bounded to ~2000 ids; oldest evicted in FIFO order.
  const SEEN_IDS_LIMIT = 2000;
  const seenCallIds = new Set<string>();
  const seenInsertionOrder: string[] = [];
  const markAndCheckDuplicate = (id: string): boolean => {
    if (seenCallIds.has(id)) return true;
    seenCallIds.add(id);
    seenInsertionOrder.push(id);
    if (seenInsertionOrder.length > SEEN_IDS_LIMIT) {
      const evict = seenInsertionOrder.shift();
      if (evict !== undefined) seenCallIds.delete(evict);
    }
    return false;
  };

  const dispatch = (event: DiagnosticEventPayload, capturedAt: number): void => {
    // Dedup by callId (model calls) or toolCallId (tool execs). Run-level
    // dedup is unreliable because the same runId fires multiple sub-events.
    const raw = event as unknown as Record<string, unknown>;
    const dedupeId =
      typeof raw["callId"] === "string"
        ? `call:${event.type}:${raw["callId"] as string}`
        : typeof raw["toolCallId"] === "string"
          ? `tool:${event.type}:${raw["toolCallId"] as string}`
          : undefined;
    if (dedupeId && markAndCheckDuplicate(dedupeId)) {
      return;
    }
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
      // Diagnostic-event-driven conversation capture for Control UI / ACP /
      // any path that doesn't fire message_received/sending hooks. The probe
      // self-gates on audit.enabled.
      deps.conversationProbe.ingestDiagnosticEvent(event, capturedAt);
    } catch {
      // ignore
    }
    try {
      deps.storeRef.get()?.appendEvent(event, capturedAt);
    } catch {
      // best-effort persistence
    }
    // Calendar-day cost rollup (v0.8.0+). The daily store does its own
    // debounced flushing to disk; we just feed it the priced event.
    if ((event.type as string) === "llm.tokens.recorded" && deps.dailyCostStoreRef) {
      try {
        deps.dailyCostStoreRef.get()?.recordTokenEvent(
          event as unknown as import("../costs/types.js").TokenRecordedEvent,
        );
      } catch {
        // best-effort
      }
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
