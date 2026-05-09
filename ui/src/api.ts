const BASE = "/api/monitor";

export type WindowSnapshot = {
  modelCalls: number;
  modelErrors: number;
  modelP95Ms: number | null;
  toolExecs: number;
  toolErrors: number;
  toolBlocked: number;
  messagesDelivered: number;
  messageErrors: number;
  webhookEvents: number;
  webhookErrors: number;
  sessionsAlerted: number;
};

export type WindowedMetrics = Record<"1m" | "5m" | "15m" | "1h", WindowSnapshot>;

export type OverviewSnapshot = {
  generatedAt: string;
  bufferedEvents: number;
  countsByType: Record<string, number>;
  recentErrors: Array<{ type: string; capturedAt: string; summary: string }>;
  windows: WindowedMetrics;
};

export type DimensionRow = {
  key: string;
  total: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  tokensIn?: number;
  tokensOut?: number;
};

export type RunSnapshot = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  trigger?: string;
  status: "active" | "completed" | "error";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  modelCalls: number;
  toolExecs: number;
};

export type LogRecord = {
  capturedAt: string;
  level?: string;
  component?: string;
  message: string;
};

export type SeriesPoint = { ts: number; value: number };

export type SeriesResponse = {
  metric: string;
  windowSec: number;
  bucketSec: number;
  points: SeriesPoint[];
};

export type ConversationSummary = {
  runId: string;
  sessionId?: string;
  channelId?: string;
  trigger?: string;
  status: "active" | "completed" | "error";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  llmHops: number;
  totalTokensIn: number;
  totalTokensOut: number;
  promptPreview?: string;
  responsePreview?: string;
  hasError: boolean;
};

export type LlmInputSegment = {
  capturedAt: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
  truncated: boolean;
};

export type LlmOutputSegment = {
  capturedAt: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  resolvedRef?: string;
  harnessId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  truncated: boolean;
};

export type ConversationRecord = {
  runId: string;
  sessionId?: string;
  agentId?: string;
  channelId?: string;
  trigger?: string;
  status: "active" | "completed" | "error";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  inbound?: {
    capturedAt: string;
    prompt: string;
    history: unknown[];
    historyCount: number;
    truncated: boolean;
  };
  llmInputs: LlmInputSegment[];
  llmOutputs: LlmOutputSegment[];
  outbound?: {
    capturedAt: string;
    success: boolean;
    messages: unknown[];
    truncated: boolean;
  };
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export const api = {
  overview: () => getJson<OverviewSnapshot>("/overview"),
  channels: () => getJson<{ rows: DimensionRow[] }>("/channels"),
  models: () => getJson<{ rows: DimensionRow[] }>("/models"),
  tools: () => getJson<{ rows: DimensionRow[] }>("/tools"),
  runs: (limit = 50) =>
    getJson<{ active: number; runs: RunSnapshot[] }>(`/runs?limit=${limit}`),
  runDetail: (runId: string) =>
    getJson<{
      run: RunSnapshot;
      events: Array<{ type: string; capturedAt: string; payload: unknown }>;
    }>(`/runs/${encodeURIComponent(runId)}`),
  logs: (params: { level?: string; component?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.level) search.set("level", params.level);
    if (params.component) search.set("component", params.component);
    if (params.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return getJson<{ records: LogRecord[] }>(`/logs${qs ? `?${qs}` : ""}`);
  },
  series: (metric: string, windowSec = 900) =>
    getJson<SeriesResponse>(`/series?metric=${encodeURIComponent(metric)}&windowSec=${windowSec}`),
  events: (params: { type?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.type) search.set("type", params.type);
    if (params.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return getJson<{
      events: Array<{ type: string; capturedAt: string; payload: unknown }>;
    }>(`/events${qs ? `?${qs}` : ""}`);
  },
  conversations: (limit = 50) =>
    getJson<{ active: number; conversations: ConversationSummary[] }>(
      `/conversations?limit=${limit}`,
    ),
  conversationDetail: (runId: string) =>
    getJson<{ conversation: ConversationRecord }>(
      `/conversations/${encodeURIComponent(runId)}`,
    ),
};

export type StreamEvent = {
  capturedAt: number;
  event: { type: string; [k: string]: unknown };
};

export function openEventStream(onEvent: (evt: StreamEvent) => void): () => void {
  const source = new EventSource(`${BASE}/stream`, { withCredentials: true });
  source.addEventListener("diagnostic", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as StreamEvent;
      onEvent(data);
    } catch {
      // ignore malformed payloads
    }
  });
  return () => source.close();
}
