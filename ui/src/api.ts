const BASE = "/api/monitor";
const TOKEN_KEY = "openclaw-monitor:token";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export const tokenStore = {
  get(): string | undefined {
    try {
      return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(token: string): void {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // localStorage may be disabled (private browsing, etc.)
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  },
};

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}
function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

function authHeaders(): HeadersInit {
  const token = tokenStore.get();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
  sessionKey?: string;
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

export type SessionGroup = {
  sessionKey: string;
  sessionId?: string;
  channelId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  runCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  hasError: boolean;
  conversations: ConversationSummary[];
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
    headers: { Accept: "application/json", ...authHeaders() },
  });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new UnauthorizedError();
  }
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
  sources: () => getJson<{ rows: DimensionRow[] }>("/sources"),
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
  conversationsBySession: (limit = 50) =>
    getJson<{ active: number; groupBy: "sessionKey"; sessions: SessionGroup[] }>(
      `/conversations?limit=${limit}&groupBy=sessionKey`,
    ),
  conversationDetail: (runId: string) =>
    getJson<{ conversation: ConversationRecord }>(
      `/conversations/${encodeURIComponent(runId)}`,
    ),
  alertsRules: () =>
    getJson<{ running: boolean; rules: AlertRule[] }>("/alerts/rules"),
  alertsActive: () => getJson<{ active: ActiveAlert[] }>("/alerts/active"),
  alertsHistory: (limit = 100) =>
    getJson<{ count: number; entries: AlertHistoryEntry[] }>(
      `/alerts/history?limit=${limit}`,
    ),
};

export type AlertSeverity = "info" | "warn" | "error";

export type AlertRule = {
  id: string;
  name: string;
  description?: string;
  metric: string;
  window: "1m" | "5m" | "15m" | "1h";
  op: ">" | ">=" | "<" | "<=" | "==";
  threshold: number;
  severity?: AlertSeverity;
  cooldownSec?: number;
  channels: string[];
  notifyOnResolve?: boolean;
};

export type ActiveAlert = {
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: string;
  window: "1m" | "5m" | "15m" | "1h";
  op: AlertRule["op"];
  threshold: number;
  lastValue: number | null;
  firedAt: string;
  lastNotifiedAt: string;
};

export type AlertHistoryEntry = {
  capturedAt: string;
  type: "fired" | "renotified" | "resolved";
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: string;
  window: "1m" | "5m" | "15m" | "1h";
  op: AlertRule["op"];
  threshold: number;
  value: number | null;
  notifications: Array<{
    channelId: string;
    kind: "webhook" | "dingtalk";
    ok: boolean;
    error?: string;
  }>;
};

export type StreamEvent = {
  capturedAt: number;
  event: { type: string; [k: string]: unknown };
};

/**
 * Fetch-based SSE reader. Native EventSource cannot send custom headers, but
 * we need to ship the Authorization bearer to the gateway. This minimal
 * implementation parses SSE blocks (event:/data: lines, blank-line terminator)
 * out of a streaming fetch response and dispatches the typed events we care
 * about.
 */
export function openEventStream(onEvent: (evt: StreamEvent) => void): () => void {
  const controller = new AbortController();
  let stopped = false;

  const consume = async (): Promise<void> => {
    try {
      const response = await fetch(`${BASE}/stream`, {
        headers: { Accept: "text/event-stream", ...authHeaders() },
        signal: controller.signal,
      });
      if (response.status === 401) {
        notifyUnauthorized();
        return;
      }
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).replace(/^ /, ""));
            }
          }
          if (eventName !== "diagnostic" || dataLines.length === 0) continue;
          try {
            onEvent(JSON.parse(dataLines.join("\n")) as StreamEvent);
          } catch {
            // skip malformed payload
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      // transient connection drop: silently exit; Layout will retry on remount
    }
  };

  void consume();

  return () => {
    stopped = true;
    controller.abort();
  };
}
