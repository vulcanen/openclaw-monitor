import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

export type EventDimensions = {
  channel?: string;
  provider?: string;
  model?: string;
  toolName?: string;
  level?: string;
  component?: string;
  outcome?: "ok" | "error" | "blocked";
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  errorMessage?: string;
  errorCategory?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  trigger?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractDimensions(event: DiagnosticEventPayload): EventDimensions {
  const raw = event as unknown as Record<string, unknown>;
  const dims: EventDimensions = {};

  const channel = asString(raw["channel"]);
  if (channel) dims.channel = channel;
  const provider = asString(raw["provider"]);
  if (provider) dims.provider = provider;
  const model = asString(raw["model"]);
  if (model) dims.model = model;
  const toolName = asString(raw["toolName"]);
  if (toolName) dims.toolName = toolName;
  const level = asString(raw["level"]);
  if (level) dims.level = level;
  const component = asString(raw["component"]);
  if (component) dims.component = component;
  const runId = asString(raw["runId"]);
  if (runId) dims.runId = runId;
  const sessionId = asString(raw["sessionId"]);
  if (sessionId) dims.sessionId = sessionId;
  const sessionKey = asString(raw["sessionKey"]);
  if (sessionKey) dims.sessionKey = sessionKey;
  const trigger = asString(raw["trigger"]);
  if (trigger) dims.trigger = trigger;
  const errorCategory = asString(raw["errorCategory"]);
  if (errorCategory) dims.errorCategory = errorCategory;
  const errorMessage = asString(raw["errorMessage"]) ?? asString(raw["message"]);
  if (errorMessage) dims.errorMessage = errorMessage;

  const duration =
    asNumber(raw["durationMs"]) ??
    asNumber(raw["duration"]) ??
    asNumber(raw["latencyMs"]);
  if (duration !== undefined) dims.durationMs = duration;

  const tokensIn = asNumber(raw["tokensIn"]) ?? asNumber(raw["inputTokens"]);
  if (tokensIn !== undefined) dims.tokensIn = tokensIn;
  const tokensOut = asNumber(raw["tokensOut"]) ?? asNumber(raw["outputTokens"]);
  if (tokensOut !== undefined) dims.tokensOut = tokensOut;

  if (event.type.endsWith(".error") || event.type === "session.stuck") {
    dims.outcome = "error";
  } else if (event.type === "tool.execution.blocked") {
    dims.outcome = "blocked";
  } else if (event.type.endsWith(".completed")) {
    dims.outcome = "ok";
  }

  return dims;
}

export function isModelCallEvent(event: DiagnosticEventPayload): boolean {
  return event.type.startsWith("model.call.");
}

export function isToolExecutionEvent(event: DiagnosticEventPayload): boolean {
  return event.type.startsWith("tool.execution.");
}

export function isMessageDeliveryEvent(event: DiagnosticEventPayload): boolean {
  return event.type.startsWith("message.delivery.");
}

// `message.processed` is the generic message-pipeline event emitted for every
// inbound message regardless of which channel/code-path produced it. This is
// the only diagnostic event we get for Control UI conversations (which do not
// fire model.call.* / harness.run.* / message.delivery.*), so we rely on it
// for Channels rollup and Control-UI-style conversation records.
export function isMessageProcessedEvent(event: DiagnosticEventPayload): boolean {
  return event.type === "message.processed";
}

export function isMessageQueuedEvent(event: DiagnosticEventPayload): boolean {
  return event.type === "message.queued";
}

// Classifies events by entry path (Control UI, OpenAI-compatible API, channel
// plugin, ...). The classification leans on the existing `channel` field that
// OpenClaw stamps on each event:
//   - "webchat"    → OpenAI-compatible HTTP API (`/v1/chat/completions`)
//   - "dashboard"  → OpenClaw Control UI built-in chat
//   - <name>       → channel plugin (telegram, discord, feishu, etc.)
export function extractSource(dims: EventDimensions): string | undefined {
  const channel = dims.channel;
  if (!channel) return undefined;
  if (channel === "webchat") return "openai-api";
  if (channel === "dashboard") return "control-ui";
  return `channel:${channel}`;
}

export function isWebhookEvent(event: DiagnosticEventPayload): boolean {
  return event.type.startsWith("webhook.");
}

export function isSessionAlertEvent(event: DiagnosticEventPayload): boolean {
  return (
    event.type === "session.stalled" ||
    event.type === "session.stuck" ||
    event.type === "diagnostic.liveness.warning"
  );
}

export function isHarnessRunEvent(event: DiagnosticEventPayload): boolean {
  return event.type.startsWith("harness.run.");
}

export function isLogEvent(event: DiagnosticEventPayload): boolean {
  return event.type === "log.record";
}
