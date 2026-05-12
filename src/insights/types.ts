// Insights / Top-N drill-down types (v0.9.0+).
//
// The aggregator returns rolled-up dimension counters ("provider/model:
// total=42 p95=...") which are great for at-a-glance health checks but
// cannot answer "which specific call was that one slow outlier?". Insights
// works the other direction: it pulls individual rows back out of the
// captured event stream so an operator can point at one runId / callId
// and click through to RunDetail.
//
// All windows are seconds-since-now; the handler clamps to [60, 24h].

export const DEFAULT_WINDOW_SEC = 15 * 60; // 15 minutes
export const MAX_WINDOW_SEC = 24 * 60 * 60;
export const MIN_WINDOW_SEC = 60;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export type SlowCallRow = {
  /** Plugin-side timestamp (ms epoch) at which the model.call.completed
   *  was captured. Used for ordering + display. */
  capturedAt: number;
  durationMs: number;
  provider?: string;
  model?: string;
  runId?: string;
  callId?: string;
  sessionKey?: string;
  /** Raw `channel` field from the host event (almost always "webchat" —
   *  the host's INTERNAL_MESSAGE_CHANNEL constant). The UI translates
   *  it through the shared inferEntryKey/friendlyEntryLabel helper
   *  before showing it to humans. */
  channel?: string;
  /** Host trigger hint, paired with runId prefix to disambiguate the
   *  entry path on the UI side (OpenAI API vs Control UI vs internal). */
  trigger?: string;
  /** Bytes the host's stream observer counted on the response — proxy
   *  for "how big was the answer". Helps explain *why* a call was slow. */
  responseStreamBytes?: number;
};

export type HeavyConversationRow = {
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
};

export type ErrorClusterRow = {
  /** Composite key used both as the row id and the human label. */
  key: string;
  provider?: string;
  model?: string;
  errorCategory?: string;
  count: number;
  /** Latest capturedAt of any event in this cluster — for "most recent" sort
   *  + recency hint in the UI. */
  lastSeenAt: number;
  /** A small sample of recent runIds so the operator can click through
   *  to RunDetail without flooding the row with everything. */
  sampleRunIds: string[];
};

export type ToolFailureRow = {
  toolName: string;
  /** Total terminal events on this tool inside the window. */
  total: number;
  /** Subset of `total` that were errors. */
  errors: number;
  /** Errors ÷ total, 0–1; rendered as %. */
  errorRate: number;
  /** Latest failing event capturedAt — for recency sort. */
  lastFailureAt?: number;
  sampleRunIds: string[];
};

export type SlowCallsResponse = {
  generatedAt: string;
  windowSec: number;
  rows: SlowCallRow[];
};

export type HeavyConversationsResponse = {
  generatedAt: string;
  windowSec: number;
  rows: HeavyConversationRow[];
};

export type ErrorClustersResponse = {
  generatedAt: string;
  windowSec: number;
  rows: ErrorClusterRow[];
};

export type ToolFailuresResponse = {
  generatedAt: string;
  windowSec: number;
  rows: ToolFailureRow[];
};
