import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DimensionRow,
  SeriesPoint,
  SeriesResponse,
  WindowSnapshot,
  WindowedMetrics,
} from "../types.js";
import {
  extractDimensions,
  extractSource,
  isMessageDeliveryEvent,
  isMessageProcessedEvent,
  isModelCallEvent,
  isToolExecutionEvent,
} from "./extractors.js";

const WINDOW_SIZES_MS = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
} as const;

type WindowKey = keyof typeof WINDOW_SIZES_MS;
const WINDOW_KEYS: readonly WindowKey[] = ["1m", "5m", "15m", "1h"];

const SERIES_BUCKET_SEC = 10;
const SERIES_BUCKETS = 60 * 60;

type RingPoint = {
  bucketTs: number;
  count: number;
};

type DimensionAccumulator = {
  total: number;
  errors: number;
  durations: number[];
  tokensIn: number;
  tokensOut: number;
};

export type Aggregator = {
  ingest: (event: DiagnosticEventPayload, capturedAtMs: number) => void;
  windows: () => WindowedMetrics;
  channels: () => DimensionRow[];
  models: () => DimensionRow[];
  tools: () => DimensionRow[];
  sources: () => DimensionRow[];
  series: (params: { metric: SeriesMetric; windowSec: number }) => SeriesResponse;
  reset: () => void;
};

export type SeriesMetric =
  | "events.total"
  | "model.calls"
  | "model.errors"
  | "tool.execs"
  | "tool.errors"
  | "messages.delivered"
  | "messages.errors";

type EventTimePoint = {
  ts: number;
  type: string;
  outcome: "ok" | "error" | "blocked" | undefined;
};

const MAX_RECENT_EVENTS = 10_000;

export function createAggregator(): Aggregator {
  const recent: EventTimePoint[] = [];
  const channelStats = new Map<string, DimensionAccumulator>();
  const modelStats = new Map<string, DimensionAccumulator>();
  const toolStats = new Map<string, DimensionAccumulator>();
  const sourceStats = new Map<string, DimensionAccumulator>();

  const seriesRings: Record<SeriesMetric, RingPoint[]> = {
    "events.total": [],
    "model.calls": [],
    "model.errors": [],
    "tool.execs": [],
    "tool.errors": [],
    "messages.delivered": [],
    "messages.errors": [],
  };

  const accFor = (map: Map<string, DimensionAccumulator>, key: string): DimensionAccumulator => {
    const existing = map.get(key);
    if (existing) return existing;
    const fresh: DimensionAccumulator = {
      total: 0,
      errors: 0,
      durations: [],
      tokensIn: 0,
      tokensOut: 0,
    };
    map.set(key, fresh);
    return fresh;
  };

  const recordSeries = (metric: SeriesMetric, ts: number, amount = 1): void => {
    const bucketTs = Math.floor(ts / 1000 / SERIES_BUCKET_SEC) * SERIES_BUCKET_SEC;
    const ring = seriesRings[metric];
    const last = ring[ring.length - 1];
    if (last && last.bucketTs === bucketTs) {
      last.count += amount;
      return;
    }
    ring.push({ bucketTs, count: amount });
    if (ring.length > SERIES_BUCKETS) {
      ring.shift();
    }
  };

  const ingest: Aggregator["ingest"] = (event, capturedAtMs) => {
    const dims = extractDimensions(event);
    const isError = dims.outcome === "error";

    recent.push({ ts: capturedAtMs, type: event.type, outcome: dims.outcome });
    if (recent.length > MAX_RECENT_EVENTS) {
      recent.shift();
    }

    recordSeries("events.total", capturedAtMs);

    // Only count the terminal `model.call.{completed,error}` events so a
    // single call doesn't show up twice (started + completed). Same for tools.
    if (isModelCallEvent(event) && event.type !== "model.call.started") {
      recordSeries("model.calls", capturedAtMs);
      if (isError) recordSeries("model.errors", capturedAtMs);
      const key = `${dims.provider ?? "unknown"}/${dims.model ?? "unknown"}`;
      const acc = accFor(modelStats, key);
      acc.total += 1;
      if (isError) acc.errors += 1;
      if (typeof dims.durationMs === "number") acc.durations.push(dims.durationMs);
      if (typeof dims.tokensIn === "number") acc.tokensIn += dims.tokensIn;
      if (typeof dims.tokensOut === "number") acc.tokensOut += dims.tokensOut;
    }

    if (isToolExecutionEvent(event) && event.type !== "tool.execution.started") {
      recordSeries("tool.execs", capturedAtMs);
      if (isError || dims.outcome === "blocked") recordSeries("tool.errors", capturedAtMs);
      if (dims.toolName) {
        const acc = accFor(toolStats, dims.toolName);
        acc.total += 1;
        if (isError || dims.outcome === "blocked") acc.errors += 1;
        if (typeof dims.durationMs === "number") acc.durations.push(dims.durationMs);
      }
    }

    if (isMessageDeliveryEvent(event)) {
      if (event.type === "message.delivery.completed") {
        recordSeries("messages.delivered", capturedAtMs);
      }
      if (isError) recordSeries("messages.errors", capturedAtMs);
      if (dims.channel) {
        const acc = accFor(channelStats, dims.channel);
        acc.total += 1;
        if (isError) acc.errors += 1;
        if (typeof dims.durationMs === "number") acc.durations.push(dims.durationMs);
      }
    }

    // Fallback: count `message.processed` events for channels that don't
    // fire message.delivery.* (Control UI, ACP, etc.). These events are
    // emitted by every inbound message regardless of channel/path.
    if (isMessageProcessedEvent(event) && dims.channel) {
      const processedEvent = event as unknown as {
        outcome?: "completed" | "skipped" | "error";
        durationMs?: number;
      };
      const isMessageError = processedEvent.outcome === "error";
      if (processedEvent.outcome === "completed") {
        recordSeries("messages.delivered", capturedAtMs);
      }
      if (isMessageError) recordSeries("messages.errors", capturedAtMs);
      const acc = accFor(channelStats, dims.channel);
      acc.total += 1;
      if (isMessageError) acc.errors += 1;
      if (typeof processedEvent.durationMs === "number") {
        acc.durations.push(processedEvent.durationMs);
      }
    }

    // Channel rollup fallback: when neither message.delivery.* nor
    // message.processed carry the activity (e.g. OpenAI-compatible API path,
    // Pi runtime via /v1/chat/completions), use the synthesized
    // model.call.completed events that hook-metrics enriches with `channel`
    // from the runId→ctx cache. Counts one channel-unit per model call,
    // which matches the per-call grain shown by the Models page.
    if (
      isModelCallEvent(event) &&
      event.type !== "model.call.started" &&
      dims.channel &&
      !isMessageDeliveryEvent(event) &&
      !isMessageProcessedEvent(event)
    ) {
      const acc = accFor(channelStats, dims.channel);
      acc.total += 1;
      if (isError) acc.errors += 1;
      if (typeof dims.durationMs === "number") acc.durations.push(dims.durationMs);
      if (typeof dims.tokensIn === "number") acc.tokensIn += dims.tokensIn;
      if (typeof dims.tokensOut === "number") acc.tokensOut += dims.tokensOut;
    }

    // Source rollup: classify any event that carries a channel into an entry
    // path category (openai-api / control-ui / channel:<name>). Lets the UI
    // answer "how much of my traffic comes from which entry path".
    const source = extractSource(dims);
    if (source) {
      const sourceAcc = accFor(sourceStats, source);
      let sourceCounted = false;
      // Same dedup-by-terminal rule as Models — count once per call, not twice.
      if (isModelCallEvent(event) && event.type !== "model.call.started") {
        sourceAcc.total += 1;
        sourceCounted = true;
        if (isError) sourceAcc.errors += 1;
        if (typeof dims.durationMs === "number") sourceAcc.durations.push(dims.durationMs);
        if (typeof dims.tokensIn === "number") sourceAcc.tokensIn += dims.tokensIn;
        if (typeof dims.tokensOut === "number") sourceAcc.tokensOut += dims.tokensOut;
      } else if (isMessageDeliveryEvent(event)) {
        sourceAcc.total += 1;
        sourceCounted = true;
        if (isError) sourceAcc.errors += 1;
        if (typeof dims.durationMs === "number") sourceAcc.durations.push(dims.durationMs);
      } else if (isMessageProcessedEvent(event)) {
        const processedEvent = event as unknown as {
          outcome?: "completed" | "skipped" | "error";
          durationMs?: number;
        };
        sourceAcc.total += 1;
        sourceCounted = true;
        if (processedEvent.outcome === "error") sourceAcc.errors += 1;
        if (typeof processedEvent.durationMs === "number") {
          sourceAcc.durations.push(processedEvent.durationMs);
        }
      }
      void sourceCounted;
    }
  };

  const cutoffsFromNow = (now: number) =>
    Object.fromEntries(
      WINDOW_KEYS.map((key) => [key, now - WINDOW_SIZES_MS[key]] as const),
    ) as Record<WindowKey, number>;

  const computeWindow = (
    cutoffMs: number,
    now: number,
  ): WindowSnapshot => {
    const snap: WindowSnapshot = {
      modelCalls: 0,
      modelErrors: 0,
      modelP95Ms: null,
      toolExecs: 0,
      toolErrors: 0,
      toolBlocked: 0,
      messagesDelivered: 0,
      messageErrors: 0,
      webhookEvents: 0,
      webhookErrors: 0,
      sessionsAlerted: 0,
    };
    void now;
    const modelDurations: number[] = [];
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const point = recent[index];
      if (!point || point.ts < cutoffMs) break;
      // Only count terminal events to avoid double-counting (started + completed).
      if (point.type.startsWith("model.call.") && point.type !== "model.call.started") {
        snap.modelCalls += 1;
        if (point.outcome === "error") snap.modelErrors += 1;
      }
      if (
        point.type.startsWith("tool.execution.") &&
        point.type !== "tool.execution.started"
      ) {
        snap.toolExecs += 1;
        if (point.outcome === "error") snap.toolErrors += 1;
        if (point.type === "tool.execution.blocked") snap.toolBlocked += 1;
      }
      if (point.type === "message.delivery.completed") snap.messagesDelivered += 1;
      if (point.type === "message.delivery.error") snap.messageErrors += 1;
      if (point.type.startsWith("webhook.")) {
        snap.webhookEvents += 1;
        if (point.type === "webhook.error") snap.webhookErrors += 1;
      }
      // Only `session.stalled` / `session.stuck` are emitted by the host's
      // per-session attention check. `diagnostic.liveness.warning` is a
      // process-wide event-loop / CPU pressure signal that the host also
      // emits during routine busy phases — counting it as a session
      // alert led to false-positive "stalled / stuck" panic on the
      // overview. Drop it from the rollup; the raw event is still in the
      // buffer for anyone who wants to inspect it on the Events page.
      if (point.type === "session.stalled" || point.type === "session.stuck") {
        snap.sessionsAlerted += 1;
      }
    }
    if (modelDurations.length > 0) {
      snap.modelP95Ms = percentile(modelDurations, 0.95);
    }
    return snap;
  };

  const windows: Aggregator["windows"] = () => {
    const now = Date.now();
    const cutoffs = cutoffsFromNow(now);
    return {
      "1m": computeWindow(cutoffs["1m"], now),
      "5m": computeWindow(cutoffs["5m"], now),
      "15m": computeWindow(cutoffs["15m"], now),
      "1h": computeWindow(cutoffs["1h"], now),
    };
  };

  const dimensionRows = (map: Map<string, DimensionAccumulator>): DimensionRow[] => {
    const rows: DimensionRow[] = [];
    for (const [key, acc] of map) {
      rows.push({
        key,
        total: acc.total,
        errors: acc.errors,
        p50Ms: acc.durations.length > 0 ? percentile(acc.durations, 0.5) : null,
        p95Ms: acc.durations.length > 0 ? percentile(acc.durations, 0.95) : null,
        ...(acc.tokensIn > 0 ? { tokensIn: acc.tokensIn } : {}),
        ...(acc.tokensOut > 0 ? { tokensOut: acc.tokensOut } : {}),
      });
    }
    rows.sort((a, b) => b.total - a.total);
    return rows;
  };

  const channels: Aggregator["channels"] = () => dimensionRows(channelStats);
  const models: Aggregator["models"] = () => dimensionRows(modelStats);
  const tools: Aggregator["tools"] = () => dimensionRows(toolStats);
  const sources: Aggregator["sources"] = () => dimensionRows(sourceStats);

  const series: Aggregator["series"] = ({ metric, windowSec }) => {
    const ring = seriesRings[metric];
    const now = Date.now();
    const cutoffSec = Math.floor(now / 1000) - windowSec;
    const points: SeriesPoint[] = [];
    for (const point of ring) {
      if (point.bucketTs < cutoffSec) continue;
      points.push({ ts: point.bucketTs * 1000, value: point.count });
    }
    return {
      metric,
      windowSec,
      bucketSec: SERIES_BUCKET_SEC,
      points,
    };
  };

  const reset: Aggregator["reset"] = () => {
    recent.length = 0;
    channelStats.clear();
    modelStats.clear();
    toolStats.clear();
    sourceStats.clear();
    for (const key of Object.keys(seriesRings) as SeriesMetric[]) {
      seriesRings[key].length = 0;
    }
  };

  return { ingest, windows, channels, models, tools, sources, series, reset };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? 0;
}
