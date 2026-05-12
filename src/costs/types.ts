// Cost / token economics types (v0.8.0+).
//
// Operators provide a price table in the host config:
//
//   plugins.entries.openclaw-monitor.config.pricing = {
//     currency: "CNY",
//     models: {
//       "qwen/qwen3-5-397b-a17b": { input: 0.0008, output: 0.002 },
//       "openai/gpt-4":            { input: 0.03,   output: 0.06 },
//       ...
//     }
//   }
//
// Units are *per 1,000 tokens*, in the configured single currency.
// We don't do FX conversion — the operator is responsible for keeping the
// price table in one currency. A model that isn't in the table will be
// counted toward token totals but not toward any cost figure (model entries
// without a price are silently zero-cost, not an error).

export type ModelPrice = {
  /** Cost per 1,000 input tokens. */
  input: number;
  /** Cost per 1,000 output tokens. */
  output: number;
  /**
   * Optional cost per 1,000 cached-read tokens. Providers like Anthropic
   * charge less for cached read than fresh input; the host's llm_output
   * hook exposes this as usage.cacheRead. Defaults to `input` when omitted.
   */
  cacheRead?: number;
  /**
   * Optional cost per 1,000 cache-write tokens. Anthropic surcharges this
   * vs fresh input. Defaults to `input` when omitted.
   */
  cacheWrite?: number;
};

export type PricingConfig = {
  /**
   * Display unit for every cost figure (totals, per-model rollups, UI).
   * Free-form string; no FX conversion happens, so make sure every entry
   * in `models` uses the same currency you put here.
   */
  currency: string;
  /**
   * Price table keyed by the canonical OpenClaw provider/model reference
   * (the same value that shows up as `provider/model` in the Models page).
   * Missing entries default to zero cost — tokens are still counted.
   */
  models: Record<string, ModelPrice>;
};

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  currency: "CNY",
  models: {},
};

/**
 * A single token-recording event injected by hook-metrics on each
 * `llm_output` hook. Its sole purpose is to feed the aggregator with the
 * token counts + computed cost for one LLM hop. Mirrors the diagnostic
 * event shape so it can travel through the existing fanout (buffer ring,
 * aggregator, SSE bus, jsonl store).
 *
 * Why a dedicated event type instead of decorating model.call.completed:
 *   - model_call_ended fires *before* llm_output (the host ends the stream
 *     observation before parsing the assistant message). Backfilling
 *     tokens onto model.call.completed would require buffering or a
 *     second pass; emitting a separate event keeps producers and
 *     consumers independent.
 *   - Some paths emit one model.call.completed but multiple llm_output
 *     events (failover, tool-call retries). One token event per
 *     llm_output gives the cleanest accounting.
 */
export type TokenRecordedEvent = {
  type: "llm.tokens.recorded";
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  channel?: string;
  trigger?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Computed at injection time using the active pricing table. */
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  /** Sum of the above; convenience field so consumers don't need pricing. */
  cost: number;
  currency: string;
  /** ISO timestamp produced at hook-fire time (not when persisted). */
  ts: number;
  seq?: number;
};

/**
 * Per-dimension cost rollup row returned by /api/monitor/costs.
 * Mirrors DimensionRow but with currency-bearing fields.
 */
export type CostDimensionRow = {
  key: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};

export type CostRangeSummary = {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};

export type CostSnapshot = {
  generatedAt: string;
  currency: string;
  /** Process-start cumulative totals. Reset on plugin/gateway restart. */
  sinceStart: CostRangeSummary;
  /**
   * Per-window costs (1m / 5m / 15m / 1h). Same rolling-window semantics
   * the Overview page uses; useful for "right now" pricing pressure.
   */
  windows: Record<"1m" | "5m" | "15m" | "1h", CostRangeSummary>;
  /**
   * Calendar-based aggregations. Computed by reading the daily-cost
   * JSONL store on disk, so they survive process restarts and reflect
   * actual operator-visible billing periods.
   */
  today: CostRangeSummary;
  thisWeek: CostRangeSummary;
  thisMonth: CostRangeSummary;
  /** Last 30 days, day buckets, for the trend chart. */
  daily: Array<{ day: string } & CostRangeSummary>;
  /** Per-model breakdown across `sinceStart`. */
  byModel: CostDimensionRow[];
  /** Per-channel breakdown across `sinceStart`. */
  byChannel: CostDimensionRow[];
  /** Per-source breakdown across `sinceStart`. */
  bySource: CostDimensionRow[];
};
