import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ConversationStore } from "./conversation-store.js";
import type {
  AuditConfig,
  ConversationRecord,
  LlmInputSegment,
  LlmOutputSegment,
} from "./types.js";

const ELLIPSIS = "…[truncated]";
const MAX_RECENT_COMPLETED = 50;
const MAX_HISTORY_ITEMS = 64;

function nowIso(): string {
  return new Date().toISOString();
}

function truncateString(value: string | undefined, max: number): { value: string | undefined; truncated: boolean } {
  if (value === undefined) return { value: undefined, truncated: false };
  if (Buffer.byteLength(value, "utf-8") <= max) return { value, truncated: false };
  const slice = value.slice(0, Math.max(0, max - ELLIPSIS.length));
  return { value: `${slice}${ELLIPSIS}`, truncated: true };
}

function clampArray<T>(items: T[], max: number): { items: T[]; truncated: boolean } {
  if (items.length <= max) return { items, truncated: false };
  return { items: items.slice(-max), truncated: true };
}

export type ConversationProbe = {
  installHooks: (api: OpenClawPluginApi) => void;
  setConfig: (config: AuditConfig) => void;
  setStore: (store: ConversationStore | undefined) => void;
  recentCompleted: () => ConversationRecord[];
  activeCount: () => number;
  reset: () => void;
};

type ProbeState = {
  config: AuditConfig;
  store: ConversationStore | undefined;
  active: Map<string, ConversationRecord>;
  recent: ConversationRecord[];
};

const DISABLED_CONFIG: AuditConfig = {
  enabled: false,
  contentMaxBytes: 16384,
  retainDays: 3,
  captureSystemPrompt: false,
};

export function createConversationProbe(): ConversationProbe {
  const state: ProbeState = {
    config: DISABLED_CONFIG,
    store: undefined,
    active: new Map(),
    recent: [],
  };

  const ensureRecord = (
    runId: string | undefined,
    seed: Partial<ConversationRecord>,
  ): ConversationRecord | undefined => {
    if (!runId) return undefined;
    const existing = state.active.get(runId);
    if (existing) return existing;
    const fresh: ConversationRecord = {
      runId,
      ...seed,
      status: "active",
      startedAt: seed.startedAt ?? nowIso(),
      llmInputs: [],
      llmOutputs: [],
    };
    state.active.set(runId, fresh);
    return fresh;
  };

  const finalize = (runId: string, mutate: (rec: ConversationRecord) => void): void => {
    const record = state.active.get(runId);
    if (!record) return;
    mutate(record);
    record.endedAt = record.endedAt ?? nowIso();
    if (!record.durationMs) {
      const startMs = Date.parse(record.startedAt);
      const endMs = Date.parse(record.endedAt);
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        record.durationMs = Math.max(0, endMs - startMs);
      }
    }
    state.active.delete(runId);
    state.recent.push(record);
    if (state.recent.length > MAX_RECENT_COMPLETED) {
      state.recent.shift();
    }
    try {
      state.store?.appendCompleted(record);
    } catch {
      // best-effort persistence
    }
  };

  const installHooks: ConversationProbe["installHooks"] = (api) => {
    api.on("before_prompt_build", (event, ctx) => {
      if (!state.config.enabled) return;
      const runId = ctx.runId;
      if (!runId) return;
      const record = ensureRecord(runId, {
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
        ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
      });
      if (!record) return;
      const promptResult = truncateString(event.prompt, state.config.contentMaxBytes);
      const history = clampArray(event.messages ?? [], MAX_HISTORY_ITEMS);
      record.inbound = {
        capturedAt: nowIso(),
        prompt: promptResult.value ?? "",
        history: history.items,
        historyCount: event.messages?.length ?? 0,
        truncated: promptResult.truncated || history.truncated,
      };
    });

    api.on("llm_input", (event, ctx) => {
      if (!state.config.enabled) return;
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const record = ensureRecord(runId, {
        ...(event.sessionId ? { sessionId: event.sessionId } : ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
        ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
      });
      if (!record) return;
      const promptResult = truncateString(event.prompt, state.config.contentMaxBytes);
      const systemResult = state.config.captureSystemPrompt
        ? truncateString(event.systemPrompt, state.config.contentMaxBytes)
        : { value: undefined, truncated: false };
      const history = clampArray(event.historyMessages ?? [], MAX_HISTORY_ITEMS);
      const segment: LlmInputSegment = {
        capturedAt: nowIso(),
        provider: event.provider,
        model: event.model,
        ...(systemResult.value !== undefined ? { systemPrompt: systemResult.value } : {}),
        prompt: promptResult.value ?? "",
        historyMessages: history.items,
        imagesCount: event.imagesCount,
        truncated: promptResult.truncated || systemResult.truncated || history.truncated,
      };
      record.llmInputs.push(segment);
    });

    api.on("llm_output", (event, ctx) => {
      if (!state.config.enabled) return;
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const record = state.active.get(runId);
      if (!record) return;
      const truncatedTexts: string[] = [];
      let truncated = false;
      for (const text of event.assistantTexts) {
        const result = truncateString(text, state.config.contentMaxBytes);
        truncatedTexts.push(result.value ?? "");
        if (result.truncated) truncated = true;
      }
      const segment: LlmOutputSegment = {
        capturedAt: nowIso(),
        provider: event.provider,
        model: event.model,
        assistantTexts: truncatedTexts,
        ...(event.resolvedRef !== undefined ? { resolvedRef: event.resolvedRef } : {}),
        ...(event.harnessId !== undefined ? { harnessId: event.harnessId } : {}),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        truncated,
      };
      record.llmOutputs.push(segment);
    });

    api.on("agent_end", (event, ctx) => {
      if (!state.config.enabled) return;
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const messages = clampArray(event.messages ?? [], MAX_HISTORY_ITEMS);
      finalize(runId, (record) => {
        record.outbound = {
          capturedAt: nowIso(),
          success: event.success,
          messages: messages.items,
          truncated: messages.truncated,
        };
        record.status = event.success ? "completed" : "error";
        if (event.error) record.errorMessage = event.error;
        if (typeof event.durationMs === "number") record.durationMs = event.durationMs;
      });
    });
  };

  return {
    installHooks,
    setConfig: (config) => {
      state.config = config;
    },
    setStore: (store) => {
      state.store = store;
    },
    recentCompleted: () => [...state.recent].reverse(),
    activeCount: () => state.active.size,
    reset: () => {
      state.active.clear();
      state.recent.length = 0;
    },
  };
}
