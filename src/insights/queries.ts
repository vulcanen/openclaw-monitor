import type { ConversationProbe } from "../audit/conversation-probe.js";
import type { ConversationStore } from "../audit/conversation-store.js";
import type { EventBuffer } from "../storage/ring-buffer.js";
import type {
  ErrorClusterRow,
  HeavyConversationRow,
  SlowCallRow,
  ToolFailureRow,
} from "./types.js";

const SAMPLE_RUN_IDS_PER_CLUSTER = 5;

/**
 * Bundle of pure-read functions over the existing in-memory buffer +
 * audit store. The Insights endpoints are thin HTTP wrappers around
 * these.
 *
 * Why this lives outside aggregator.ts: aggregator owns the rolled-up
 * counters ("provider/model: total=42, p95=..."). Insights goes the
 * opposite direction — it finds individual outlier rows, not summary
 * stats — so it shouldn't share aggregator's accumulator data
 * structures. We pull from the buffer's per-type ring (which already
 * keeps the last `maxPerType` events of each kind), filter by time
 * window, sort, slice. No new persistent state.
 */
export function createInsightsQueries(deps: {
  buffer: EventBuffer;
  conversationProbe: ConversationProbe;
  conversationStoreRef: { get: () => ConversationStore | undefined };
}) {
  /**
   * Top-N slowest model.call.completed events inside [now - windowSec, now].
   * Sorted by durationMs descending. Cap on rows = `limit`.
   */
  const slowCalls = (params: { windowSec: number; limit: number }): SlowCallRow[] => {
    const cutoff = Date.now() - params.windowSec * 1000;
    // Pull the whole buffer ring for the type — 1024 entries by default
    // is fine; if an operator tunes maxPerType higher we get more. We
    // don't paginate here because the ring is bounded by config anyway.
    const items = deps.buffer.recent({ type: "model.call.completed", limit: 2048 });
    const rows: SlowCallRow[] = [];
    for (const item of items) {
      if (item.capturedAt < cutoff) continue;
      const raw = item.event as unknown as Record<string, unknown>;
      const duration = typeof raw["durationMs"] === "number" ? raw["durationMs"] : undefined;
      if (typeof duration !== "number") continue;
      rows.push({
        capturedAt: item.capturedAt,
        durationMs: duration,
        ...(typeof raw["provider"] === "string" ? { provider: raw["provider"] } : {}),
        ...(typeof raw["model"] === "string" ? { model: raw["model"] } : {}),
        ...(typeof raw["runId"] === "string" ? { runId: raw["runId"] } : {}),
        ...(typeof raw["callId"] === "string" ? { callId: raw["callId"] } : {}),
        ...(typeof raw["sessionKey"] === "string" ? { sessionKey: raw["sessionKey"] } : {}),
        ...(typeof raw["channel"] === "string" ? { channel: raw["channel"] } : {}),
        ...(typeof raw["trigger"] === "string" ? { trigger: raw["trigger"] } : {}),
        ...(typeof raw["responseStreamBytes"] === "number"
          ? { responseStreamBytes: raw["responseStreamBytes"] }
          : {}),
      });
    }
    rows.sort((a, b) => b.durationMs - a.durationMs);
    return rows.slice(0, params.limit);
  };

  /**
   * Top-N conversations by total token usage inside the window. Includes
   * in-flight + persisted records so an operator can spot a runaway
   * conversation while it's still consuming tokens. "Window" matches by
   * either startedAt or endedAt — being permissive avoids dropping a
   * long-running conversation that started before the window but is
   * still spending.
   */
  const heavyConversations = (params: {
    windowSec: number;
    limit: number;
  }): HeavyConversationRow[] => {
    const cutoffMs = Date.now() - params.windowSec * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const summaries = new Map<
      string,
      {
        runId: string;
        sessionId?: string;
        sessionKey?: string;
        channelId?: string;
        trigger?: string;
        startedAt: string;
        endedAt?: string;
        durationMs?: number;
        llmHops: number;
        totalTokensIn: number;
        totalTokensOut: number;
        promptPreview?: string;
      }
    >();

    // 1. In-memory probe (active + recent completed) first.
    for (const record of deps.conversationProbe.recentCompleted()) {
      let tIn = 0;
      let tOut = 0;
      for (const out of record.llmOutputs) {
        tIn += out.usage?.input ?? 0;
        tOut += out.usage?.output ?? 0;
      }
      summaries.set(record.runId, {
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
        ...(record.channelId ? { channelId: record.channelId } : {}),
        ...(record.trigger ? { trigger: record.trigger } : {}),
        startedAt: record.startedAt,
        ...(record.endedAt ? { endedAt: record.endedAt } : {}),
        ...(record.durationMs ? { durationMs: record.durationMs } : {}),
        llmHops: record.llmInputs.length,
        totalTokensIn: tIn,
        totalTokensOut: tOut,
        ...(record.inbound?.prompt ? { promptPreview: record.inbound.prompt.slice(0, 160) } : {}),
      });
    }
    // 2. Persisted summaries: pull a generous slice (top 500 sessions for
    //    today + yesterday is more than the heaviest dashboard needs).
    const persisted = deps.conversationStoreRef.get()?.list({ limit: 500 }) ?? [];
    for (const summary of persisted) {
      if (summaries.has(summary.runId)) continue;
      summaries.set(summary.runId, {
        runId: summary.runId,
        ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
        ...(summary.sessionKey ? { sessionKey: summary.sessionKey } : {}),
        ...(summary.channelId ? { channelId: summary.channelId } : {}),
        ...(summary.trigger ? { trigger: summary.trigger } : {}),
        startedAt: summary.startedAt,
        ...(summary.endedAt ? { endedAt: summary.endedAt } : {}),
        ...(summary.durationMs ? { durationMs: summary.durationMs } : {}),
        llmHops: summary.llmHops,
        totalTokensIn: summary.totalTokensIn,
        totalTokensOut: summary.totalTokensOut,
        ...(summary.promptPreview ? { promptPreview: summary.promptPreview } : {}),
      });
    }

    const rows: HeavyConversationRow[] = [];
    for (const s of summaries.values()) {
      // Inside the window if either edge falls within. We use ISO string
      // comparison since startedAt / endedAt are normalised ISO already.
      const startInWindow = s.startedAt >= cutoffIso;
      const endInWindow = !s.endedAt || s.endedAt >= cutoffIso;
      if (!startInWindow && !endInWindow) continue;
      rows.push(s);
    }
    rows.sort((a, b) => b.totalTokensIn + b.totalTokensOut - (a.totalTokensIn + a.totalTokensOut));
    return rows.slice(0, params.limit);
  };

  /**
   * Cluster model.call.error events by (provider, model, errorCategory)
   * inside the window. Used to answer "what's failing the most and
   * which provider/model is responsible?".
   */
  const errorClusters = (params: { windowSec: number; limit: number }): ErrorClusterRow[] => {
    const cutoff = Date.now() - params.windowSec * 1000;
    const items = deps.buffer.recent({ type: "model.call.error", limit: 2048 });
    const clusters = new Map<string, ErrorClusterRow>();
    for (const item of items) {
      if (item.capturedAt < cutoff) continue;
      const raw = item.event as unknown as Record<string, unknown>;
      const provider = typeof raw["provider"] === "string" ? raw["provider"] : undefined;
      const model = typeof raw["model"] === "string" ? raw["model"] : undefined;
      const errorCategory =
        typeof raw["errorCategory"] === "string" ? raw["errorCategory"] : "unknown";
      const runId = typeof raw["runId"] === "string" ? raw["runId"] : undefined;
      const key = `${provider ?? "unknown"}/${model ?? "unknown"} · ${errorCategory}`;
      const existing = clusters.get(key);
      if (existing) {
        existing.count += 1;
        if (item.capturedAt > existing.lastSeenAt) existing.lastSeenAt = item.capturedAt;
        if (runId && existing.sampleRunIds.length < SAMPLE_RUN_IDS_PER_CLUSTER) {
          if (!existing.sampleRunIds.includes(runId)) existing.sampleRunIds.push(runId);
        }
      } else {
        clusters.set(key, {
          key,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          errorCategory,
          count: 1,
          lastSeenAt: item.capturedAt,
          sampleRunIds: runId ? [runId] : [],
        });
      }
    }
    const rows = Array.from(clusters.values());
    rows.sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt);
    return rows.slice(0, params.limit);
  };

  /**
   * Per-tool failure rate inside the window. Useful to spot a flaky tool
   * (browse / fetch / shell / mcp:* / etc.) that's quietly inflating
   * agent retry loops.
   */
  const toolFailures = (params: { windowSec: number; limit: number }): ToolFailureRow[] => {
    const cutoff = Date.now() - params.windowSec * 1000;
    const totals = new Map<
      string,
      { total: number; errors: number; lastFailureAt?: number; sampleRunIds: string[] }
    >();
    for (const type of ["tool.execution.completed", "tool.execution.error"] as const) {
      const items = deps.buffer.recent({ type, limit: 2048 });
      for (const item of items) {
        if (item.capturedAt < cutoff) continue;
        const raw = item.event as unknown as Record<string, unknown>;
        const toolName = typeof raw["toolName"] === "string" ? raw["toolName"] : "unknown";
        const runId = typeof raw["runId"] === "string" ? raw["runId"] : undefined;
        const entry = totals.get(toolName) ?? {
          total: 0,
          errors: 0,
          sampleRunIds: [],
        };
        entry.total += 1;
        if (type === "tool.execution.error") {
          entry.errors += 1;
          if (!entry.lastFailureAt || item.capturedAt > entry.lastFailureAt) {
            entry.lastFailureAt = item.capturedAt;
          }
          if (runId && entry.sampleRunIds.length < SAMPLE_RUN_IDS_PER_CLUSTER) {
            if (!entry.sampleRunIds.includes(runId)) entry.sampleRunIds.push(runId);
          }
        }
        totals.set(toolName, entry);
      }
    }
    const rows: ToolFailureRow[] = [];
    for (const [toolName, v] of totals) {
      if (v.errors === 0) continue;
      rows.push({
        toolName,
        total: v.total,
        errors: v.errors,
        errorRate: v.total === 0 ? 0 : v.errors / v.total,
        ...(v.lastFailureAt !== undefined ? { lastFailureAt: v.lastFailureAt } : {}),
        sampleRunIds: v.sampleRunIds,
      });
    }
    // Sort by error count desc then error rate desc — surfaces the
    // tool that's both *failing the most* and *failing the most often*.
    rows.sort((a, b) => b.errors - a.errors || b.errorRate - a.errorRate);
    return rows.slice(0, params.limit);
  };

  return { slowCalls, heavyConversations, errorClusters, toolFailures };
}
