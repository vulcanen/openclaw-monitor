import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { ConversationProbe } from "../audit/conversation-probe.js";
import type { Aggregator } from "../pipeline/aggregator.js";
import type { RunsTracker } from "../pipeline/runs-tracker.js";
import type { StoreRef } from "../storage/store-ref.js";
import type { EventBuffer } from "../storage/ring-buffer.js";
import type { EventBus } from "../outlets/event-bus.js";
import type { DailyCostStoreRef } from "../costs/store-ref.js";
import type { TokenRecordedEvent } from "../costs/types.js";

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
  dailyCostStoreRef?: DailyCostStoreRef;
};

export function createEventFanout(deps: EventFanoutDeps): EventFanout {
  let unsubscribe: (() => void) | undefined;
  // Dedup ring for synthesized vs natural events. If the host emits BOTH a
  // diagnostic event and the matching hook for the same call, the second
  // arrival is dropped. Bounded to ~2000 ids.
  //
  // Implementation: a fixed-size circular array of slot keys, plus a Set
  // for O(1) membership. Writes are O(1) (overwrite the slot at `cursor`
  // and delete the evicted key from the Set). The previous implementation
  // used `Array#shift()` which is O(n) on V8 — at 10k events/s with the
  // ring full, every eviction copied 2000 elements (~50–100 μs each) so a
  // steady ~5 evictions/sec wasted ~250–500 μs of CPU continuously.
  const SEEN_IDS_LIMIT = 2000;
  const seenCallIds = new Set<string>();
  const seenSlots: (string | undefined)[] = new Array(SEEN_IDS_LIMIT);
  let seenCursor = 0;
  const markAndCheckDuplicate = (id: string): boolean => {
    if (seenCallIds.has(id)) return true;
    seenCallIds.add(id);
    const evict = seenSlots[seenCursor];
    if (evict !== undefined) seenCallIds.delete(evict);
    seenSlots[seenCursor] = id;
    seenCursor = (seenCursor + 1) % SEEN_IDS_LIMIT;
    return false;
  };

  const dispatch = (event: DiagnosticEventPayload, capturedAt: number): void => {
    // Dedup by callId (model calls) or toolCallId (tool execs). Run-level
    // dedup is unreliable because the same runId fires multiple sub-events.
    // For `llm.tokens.recorded` we use (runId, seq) since that synthetic
    // event carries no callId — the seq is monotonic per hook-metrics
    // install, so distinct legitimate events always differ.
    const raw = event as unknown as Record<string, unknown>;
    const dedupeId =
      typeof raw["callId"] === "string"
        ? `call:${event.type}:${raw["callId"]}`
        : typeof raw["toolCallId"] === "string"
          ? `tool:${event.type}:${raw["toolCallId"]}`
          : (event.type as string) === "llm.tokens.recorded" &&
              typeof raw["runId"] === "string" &&
              typeof raw["seq"] === "number"
            ? `tok:${raw["runId"]}:${raw["seq"]}`
            : undefined;
    if (dedupeId && markAndCheckDuplicate(dedupeId)) {
      return;
    }
    try {
      deps.buffer.append(event, capturedAt);
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
        deps.dailyCostStoreRef.get()?.recordTokenEvent(event as unknown as TokenRecordedEvent);
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
