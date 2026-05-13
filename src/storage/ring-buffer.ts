import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CapturedEvent, EventType } from "../types.js";

export type EventBuffer = {
  /**
   * @param capturedAtMs Optional explicit capture timestamp. Live fanout
   *   omits it and we stamp `Date.now()`. The startup replay path must
   *   pass the original timestamp from the JSONL store so the Logs /
   *   Insights / Overview "recent" surfaces don't display historic
   *   errors as if they just happened.
   */
  append: (event: DiagnosticEventPayload, capturedAtMs?: number) => void;
  size: () => number;
  countsByType: () => Record<string, number>;
  recent: (params?: { type?: EventType; limit?: number }) => CapturedEvent[];
  clear: () => void;
};

type PerTypeRing = {
  items: CapturedEvent[];
  cursor: number;
  total: number;
};

export function createEventBuffer(opts: { maxPerType: number }): EventBuffer {
  const maxPerType = Math.max(1, Math.floor(opts.maxPerType));
  const rings = new Map<string, PerTypeRing>();

  const ringFor = (type: string): PerTypeRing => {
    const existing = rings.get(type);
    if (existing) return existing;
    const ring: PerTypeRing = { items: [], cursor: 0, total: 0 };
    rings.set(type, ring);
    return ring;
  };

  const append: EventBuffer["append"] = (event, capturedAtMs) => {
    const ring = ringFor(event.type);
    const captured: CapturedEvent = {
      event,
      capturedAt: capturedAtMs ?? Date.now(),
    };
    if (ring.items.length < maxPerType) {
      ring.items.push(captured);
    } else {
      ring.items[ring.cursor] = captured;
      ring.cursor = (ring.cursor + 1) % maxPerType;
    }
    ring.total += 1;
  };

  const size: EventBuffer["size"] = () => {
    let total = 0;
    for (const ring of rings.values()) {
      total += ring.items.length;
    }
    return total;
  };

  const countsByType: EventBuffer["countsByType"] = () => {
    const out: Record<string, number> = {};
    for (const [type, ring] of rings) {
      out[type] = ring.total;
    }
    return out;
  };

  const orderedItems = (ring: PerTypeRing): CapturedEvent[] => {
    if (ring.items.length < maxPerType) {
      return [...ring.items];
    }
    return [...ring.items.slice(ring.cursor), ...ring.items.slice(0, ring.cursor)];
  };

  const recent: EventBuffer["recent"] = (params) => {
    const limit = params?.limit ?? 100;
    if (params?.type) {
      const ring = rings.get(params.type);
      if (!ring) return [];
      return orderedItems(ring).slice(-limit);
    }
    const all: CapturedEvent[] = [];
    for (const ring of rings.values()) {
      all.push(...orderedItems(ring));
    }
    all.sort((a, b) => a.capturedAt - b.capturedAt);
    return all.slice(-limit);
  };

  const clear: EventBuffer["clear"] = () => {
    rings.clear();
  };

  return { append, size, countsByType, recent, clear };
}
