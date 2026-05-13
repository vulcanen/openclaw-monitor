/**
 * Client-side computation of a `DimensionRow[]` from raw events, filtered
 * by the global time window (v0.9.7.2).
 *
 * Pre-v0.9.7.2 the Tools / Models / Channels / Sources pages read
 * cumulative-since-process-start rollups from /api/monitor/{tools,models,
 * channels,sources}. That endpoint has no time-window concept — the
 * aggregator's per-dimension counters are append-only. Operators changing
 * the global window picker saw no effect.
 *
 * Doing it client-side lets the page respect any window without a backend
 * schema change. Trade-off: the source data is the ring buffer (defaults
 * to 1024 per type), so for chatty deployments at the 24h window we'll
 * undercount because older events have rotated out. The page subtitle
 * surfaces the cap so operators aren't confused.
 *
 * A backend-side windowed-dimension route would need to extend the
 * aggregator's `recent` ring with per-event dimension fields — done as a
 * follow-up if quality of the client-side approach proves insufficient.
 */

import { inferEntryKey } from "../entry-label.js";

export type DimensionRow = {
  key: string;
  total: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
};

export type RawEvent = {
  type: string;
  capturedAt: string;
  payload: Record<string, unknown>;
};

type Accumulator = {
  total: number;
  errors: number;
  durations: number[];
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};

function emptyAcc(): Accumulator {
  return {
    total: 0,
    errors: 0,
    durations: [],
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx] ?? null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Compute dimensions by extracting `key(event)` and accumulating
 * total/errors/durations/tokens from the event payload. Events whose key
 * extractor returns `undefined` are skipped (e.g. tool events with no
 * toolName).
 */
function buildRows(
  events: RawEvent[],
  cutoffMs: number,
  keyFor: (evt: RawEvent) => string | undefined,
  isError: (evt: RawEvent) => boolean,
): DimensionRow[] {
  const acc = new Map<string, Accumulator>();
  for (const evt of events) {
    const ts = Date.parse(evt.capturedAt);
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const key = keyFor(evt);
    if (!key) continue;
    let a = acc.get(key);
    if (!a) {
      a = emptyAcc();
      acc.set(key, a);
    }
    a.total += 1;
    if (isError(evt)) a.errors += 1;
    const dur = asNumber(evt.payload["durationMs"]);
    if (dur !== undefined) a.durations.push(dur);
    // llm.tokens.recorded carries cost / token splits; merged in below.
  }
  const rows: DimensionRow[] = [];
  for (const [key, a] of acc) {
    rows.push({
      key,
      total: a.total,
      errors: a.errors,
      p50Ms: percentile(a.durations, 0.5),
      p95Ms: percentile(a.durations, 0.95),
      ...(a.tokensIn > 0 ? { tokensIn: a.tokensIn } : {}),
      ...(a.tokensOut > 0 ? { tokensOut: a.tokensOut } : {}),
      ...(a.cacheReadTokens > 0 ? { cacheReadTokens: a.cacheReadTokens } : {}),
      ...(a.cacheWriteTokens > 0 ? { cacheWriteTokens: a.cacheWriteTokens } : {}),
      ...(a.cost > 0 ? { cost: a.cost } : {}),
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

/**
 * Apply llm.tokens.recorded events as a side accumulation onto an
 * already-built dimension table. Token events live in their own type, so
 * we layer them on rather than mixing into the primary buildRows loop —
 * matches backend aggregator behaviour (decision #25 / #26).
 */
function applyTokenEvents(
  rows: DimensionRow[],
  tokenEvents: RawEvent[],
  cutoffMs: number,
  keyFor: (evt: RawEvent) => string | undefined,
): DimensionRow[] {
  if (tokenEvents.length === 0) return rows;
  // Accumulate token totals into plain-number maps keyed by dimension key.
  // Avoids mutating DimensionRow (which has optional fields tsconfig
  // treats as readonly under exactOptionalPropertyTypes); we'll splice
  // the totals back into rows in one rebuild pass at the end.
  type TokenTotals = {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
  };
  const byKey = new Map<string, TokenTotals>();
  for (const evt of tokenEvents) {
    const ts = Date.parse(evt.capturedAt);
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const key = keyFor(evt);
    if (!key) continue;
    let t = byKey.get(key);
    if (!t) {
      t = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
      byKey.set(key, t);
    }
    const p = evt.payload;
    t.tokensIn += asNumber(p["inputTokens"]) ?? 0;
    t.tokensOut += asNumber(p["outputTokens"]) ?? 0;
    t.cacheReadTokens += asNumber(p["cacheReadTokens"]) ?? 0;
    t.cacheWriteTokens += asNumber(p["cacheWriteTokens"]) ?? 0;
    t.cost += asNumber(p["cost"]) ?? 0;
  }
  // Merge token totals back into existing rows; emit fresh rows for keys
  // that only appeared in token events.
  const seenKeys = new Set<string>();
  const out: DimensionRow[] = rows.map((r) => {
    seenKeys.add(r.key);
    const t = byKey.get(r.key);
    if (!t) return r;
    return {
      ...r,
      ...(t.tokensIn > 0 ? { tokensIn: t.tokensIn } : {}),
      ...(t.tokensOut > 0 ? { tokensOut: t.tokensOut } : {}),
      ...(t.cacheReadTokens > 0 ? { cacheReadTokens: t.cacheReadTokens } : {}),
      ...(t.cacheWriteTokens > 0 ? { cacheWriteTokens: t.cacheWriteTokens } : {}),
      ...(t.cost > 0 ? { cost: t.cost } : {}),
    };
  });
  for (const [key, t] of byKey) {
    if (seenKeys.has(key)) continue;
    out.push({
      key,
      total: 0,
      errors: 0,
      p50Ms: null,
      p95Ms: null,
      ...(t.tokensIn > 0 ? { tokensIn: t.tokensIn } : {}),
      ...(t.tokensOut > 0 ? { tokensOut: t.tokensOut } : {}),
      ...(t.cacheReadTokens > 0 ? { cacheReadTokens: t.cacheReadTokens } : {}),
      ...(t.cacheWriteTokens > 0 ? { cacheWriteTokens: t.cacheWriteTokens } : {}),
      ...(t.cost > 0 ? { cost: t.cost } : {}),
    });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

// ── Per-dimension presets ────────────────────────────────────────────────

/** model.call.{completed,error} → key=provider/model */
export function modelsFromEvents(
  modelEvents: RawEvent[],
  tokenEvents: RawEvent[],
  cutoffMs: number,
): DimensionRow[] {
  const keyFor = (evt: RawEvent): string | undefined => {
    const provider = asString(evt.payload["provider"]) ?? "unknown";
    const model = asString(evt.payload["model"]) ?? "unknown";
    if (provider === "unknown" && model === "unknown") return undefined;
    return `${provider}/${model}`;
  };
  // Only count terminal events (completed / error) — model.call.started
  // would double-count.
  const terminal = modelEvents.filter(
    (e) => e.type === "model.call.completed" || e.type === "model.call.error",
  );
  const base = buildRows(terminal, cutoffMs, keyFor, (e) => e.type === "model.call.error");
  return applyTokenEvents(base, tokenEvents, cutoffMs, keyFor);
}

/** tool.execution.{completed,error,blocked} → key=toolName */
export function toolsFromEvents(toolEvents: RawEvent[], cutoffMs: number): DimensionRow[] {
  const keyFor = (evt: RawEvent): string | undefined => asString(evt.payload["toolName"]);
  const terminal = toolEvents.filter(
    (e) =>
      e.type === "tool.execution.completed" ||
      e.type === "tool.execution.error" ||
      e.type === "tool.execution.blocked",
  );
  return buildRows(
    terminal,
    cutoffMs,
    keyFor,
    (e) => e.type === "tool.execution.error" || e.type === "tool.execution.blocked",
  );
}

/** message.{delivery.*,processed} + model.call.* with channel → key=channel */
export function channelsFromEvents(
  messageEvents: RawEvent[],
  modelEvents: RawEvent[],
  tokenEvents: RawEvent[],
  cutoffMs: number,
): DimensionRow[] {
  const keyFor = (evt: RawEvent): string | undefined => asString(evt.payload["channel"]);
  // message.delivery.completed/error + message.processed + model.call.completed/error
  const relevant = [
    ...messageEvents.filter(
      (e) =>
        e.type === "message.delivery.completed" ||
        e.type === "message.delivery.error" ||
        e.type === "message.processed",
    ),
    ...modelEvents.filter(
      (e) => e.type === "model.call.completed" || e.type === "model.call.error",
    ),
  ];
  const base = buildRows(
    relevant,
    cutoffMs,
    keyFor,
    (e) =>
      e.type.endsWith(".error") || (e.type === "message.processed" && evtOutcome(e) === "error"),
  );
  return applyTokenEvents(base, tokenEvents, cutoffMs, keyFor);
}

/** Source via inferEntryKey(channel, trigger, runId) */
export function sourcesFromEvents(
  messageEvents: RawEvent[],
  modelEvents: RawEvent[],
  tokenEvents: RawEvent[],
  cutoffMs: number,
): DimensionRow[] {
  const keyFor = (evt: RawEvent): string | undefined =>
    inferEntryKey(
      asString(evt.payload["channel"]),
      asString(evt.payload["trigger"]),
      asString(evt.payload["runId"]),
    );
  const relevant = [
    ...messageEvents.filter(
      (e) =>
        e.type === "message.delivery.completed" ||
        e.type === "message.delivery.error" ||
        e.type === "message.processed",
    ),
    ...modelEvents.filter(
      (e) => e.type === "model.call.completed" || e.type === "model.call.error",
    ),
  ];
  const base = buildRows(
    relevant,
    cutoffMs,
    keyFor,
    (e) =>
      e.type.endsWith(".error") || (e.type === "message.processed" && evtOutcome(e) === "error"),
  );
  return applyTokenEvents(base, tokenEvents, cutoffMs, keyFor);
}

function evtOutcome(evt: RawEvent): string | undefined {
  return asString(evt.payload["outcome"]);
}
