import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type EventType = DiagnosticEventPayload["type"];

export type CapturedEvent = {
  event: DiagnosticEventPayload;
  capturedAt: number;
};

export type OverviewSnapshot = {
  generatedAt: string;
  bufferedEvents: number;
  countsByType: Record<string, number>;
  recentErrors: Array<{
    type: string;
    capturedAt: string;
    summary: string;
  }>;
  windows: WindowedMetrics;
};

export type WindowedMetrics = {
  "1m": WindowSnapshot;
  "5m": WindowSnapshot;
  "15m": WindowSnapshot;
  "1h": WindowSnapshot;
};

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

export type SeriesPoint = {
  ts: number;
  value: number;
};

export type SeriesResponse = {
  metric: string;
  windowSec: number;
  bucketSec: number;
  points: SeriesPoint[];
};

export type MonitorConfig = {
  buffer: {
    maxPerType: number;
  };
  storage: {
    kind: "jsonl" | "memory";
    path?: string;
  };
  retention: {
    eventsDays: number;
    runsDays: number;
  };
  ui: {
    enabled: boolean;
  };
  stream: {
    maxSubscribers: number;
    heartbeatMs: number;
  };
  audit: {
    enabled: boolean;
    contentMaxBytes: number;
    retainDays: number;
    captureSystemPrompt: boolean;
  };
};

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  buffer: { maxPerType: 1024 },
  storage: { kind: "jsonl" },
  retention: { eventsDays: 7, runsDays: 90 },
  ui: { enabled: true },
  stream: { maxSubscribers: 16, heartbeatMs: 15_000 },
  audit: {
    enabled: true,
    // Raised from 16 KB (v0.5.2 and earlier) to 1 MB so the conversation
    // detail page can show full prompts and full assistant responses
    // without "...[truncated]". The schema cap is 16 MB; bump
    // plugins.entries.openclaw-monitor.config.audit.contentMaxBytes if you
    // need to capture even larger payloads.
    contentMaxBytes: 1_048_576,
    retainDays: 3,
    captureSystemPrompt: true,
  },
};

export type HttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
