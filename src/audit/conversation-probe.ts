import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
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
const PLUGIN_ID = "openclaw-monitor";

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
  ingestDiagnosticEvent: (event: DiagnosticEventPayload, capturedAtMs: number) => void;
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
  bySessionKey: Map<string, string>;
  recent: ConversationRecord[];
};

const DISABLED_CONFIG: AuditConfig = {
  enabled: false,
  contentMaxBytes: 16384,
  retainDays: 3,
  captureSystemPrompt: false,
};

function readHostAuditFlags(api: OpenClawPluginApi): {
  auditEnabled: boolean;
  allowConversationAccess: boolean;
} {
  try {
    const config = api.runtime.config.current() as unknown as {
      plugins?: { entries?: Record<string, unknown> };
    };
    // OpenClaw splits per-plugin config into two namespaces under entries.<id>:
    //   .hooks.*  -> host-level safety gates (e.g. allowConversationAccess)
    //   .config.* -> plugin's own configSchema data (e.g. audit.enabled)
    const entry = config.plugins?.entries?.[PLUGIN_ID] as
      | {
          hooks?: { allowConversationAccess?: boolean };
          config?: { audit?: { enabled?: boolean } };
        }
      | undefined;
    return {
      auditEnabled: entry?.config?.audit?.enabled === true,
      allowConversationAccess: entry?.hooks?.allowConversationAccess === true,
    };
  } catch {
    return { auditEnabled: false, allowConversationAccess: false };
  }
}

export function createConversationProbe(): ConversationProbe {
  const state: ProbeState = {
    config: DISABLED_CONFIG,
    store: undefined,
    active: new Map(),
    bySessionKey: new Map(),
    recent: [],
  };

  // Look up an existing record by (sessionKey || runId), or create a new one.
  // Channel-only flows (message_received without a real harness run) bring
  // sessionKey but no runId — we mint a synthetic runId and key the record by
  // sessionKey so a later before_prompt_build with a real runId in the same
  // session merges into the same record.
  const findOrCreateRecord = (
    ids: { runId?: string; sessionKey?: string },
    seed: Partial<ConversationRecord>,
  ): ConversationRecord | undefined => {
    const { runId, sessionKey } = ids;
    if (!runId && !sessionKey) return undefined;

    // sessionKey takes precedence (more stable across hook order)
    if (sessionKey) {
      const linkedRunId = state.bySessionKey.get(sessionKey);
      if (linkedRunId) {
        const linked = state.active.get(linkedRunId);
        if (linked) {
          // Promote synthetic runId to the real one when an agent harness
          // run finally arrives. Without this re-key, the record stays
          // indexed by `ctrl_<sessionKey>_<ts>` in state.active, and
          // any handler that looks up by *runId only* (e.g. llm_output)
          // would miss it — the LLM→OpenClaw section would stay empty
          // for channel-based flows even though we did capture the data.
          if (runId && runId !== linked.runId && linked.runId.startsWith("ctrl_")) {
            state.active.delete(linked.runId);
            linked.runId = runId;
            state.active.set(runId, linked);
            state.bySessionKey.set(sessionKey, runId);
          }
          return linked;
        }
      }
    }

    if (runId) {
      const byRun = state.active.get(runId);
      if (byRun) {
        if (sessionKey && !state.bySessionKey.has(sessionKey)) {
          state.bySessionKey.set(sessionKey, byRun.runId);
        }
        return byRun;
      }
    }

    const effectiveRunId =
      runId ??
      (sessionKey
        ? `ctrl_${sessionKey.replace(/[^A-Za-z0-9_-]/gu, "_")}_${Date.now()}`
        : undefined);
    if (!effectiveRunId) return undefined;

    const fresh: ConversationRecord = {
      runId: effectiveRunId,
      ...seed,
      ...(sessionKey ? { sessionKey } : {}),
      status: "active",
      startedAt: seed.startedAt ?? nowIso(),
      llmInputs: [],
      llmOutputs: [],
    };
    state.active.set(effectiveRunId, fresh);
    if (sessionKey) state.bySessionKey.set(sessionKey, effectiveRunId);
    return fresh;
  };

  const finalize = (
    target: { runId?: string; sessionKey?: string },
    mutate: (rec: ConversationRecord) => void,
  ): void => {
    let record: ConversationRecord | undefined;
    if (target.sessionKey) {
      const linkedRunId = state.bySessionKey.get(target.sessionKey);
      if (linkedRunId) record = state.active.get(linkedRunId);
    }
    if (!record && target.runId) {
      record = state.active.get(target.runId);
    }
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
    state.active.delete(record.runId);
    if (record.sessionKey) state.bySessionKey.delete(record.sessionKey);
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
    // ── Non-gated hooks: register unconditionally (only audit.enabled gates work). ──

    api.on("before_prompt_build", (event, ctx) => {
      if (!state.config.enabled) return;
      const record = findOrCreateRecord(
        { ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}), ...(ctx.sessionKey !== undefined ? { sessionKey: ctx.sessionKey } : {}) },
        {
          ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
          ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
          ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
        },
      );
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

    // Channel-side inbound (Control UI, Telegram, Discord, etc.). Fires for
    // every channel message — even ones that never trigger an agent harness —
    // so we get visibility for Control UI conversations that don't fire
    // before_prompt_build / llm_input.
    api.on("message_received", (event, ctx) => {
      if (!state.config.enabled) return;
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const runId = event.runId ?? ctx.runId;
      if (!sessionKey && !runId) return;
      const record = findOrCreateRecord(
        {
          ...(runId !== undefined ? { runId } : {}),
          ...(sessionKey !== undefined ? { sessionKey } : {}),
        },
        {
          ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
          trigger: "channel-message",
        },
      );
      if (!record) return;
      // Only set inbound if a more authoritative source (before_prompt_build)
      // hasn't already filled it in for this conversation.
      if (!record.inbound) {
        const promptResult = truncateString(event.content, state.config.contentMaxBytes);
        record.inbound = {
          capturedAt: nowIso(),
          prompt: promptResult.value ?? "",
          history: [],
          historyCount: 0,
          truncated: promptResult.truncated,
        };
      }
    });

    // Channel-side outbound. Some flows (Control UI without a harness run)
    // never fire agent_end, so this is the only chance to capture the reply
    // and finalize the record.
    api.on("message_sending", (event, ctx) => {
      if (!state.config.enabled) return;
      const sessionKey = ctx.sessionKey;
      const runId = ctx.runId;
      if (!sessionKey && !runId) return;
      const lookupSessionKey: string | undefined =
        sessionKey ??
        (runId !== undefined
          ? Array.from(state.bySessionKey.entries()).find(([, r]) => r === runId)?.[0]
          : undefined);
      const linkedRunId =
        (lookupSessionKey !== undefined ? state.bySessionKey.get(lookupSessionKey) : undefined) ??
        runId;
      if (!linkedRunId) return;
      const record = state.active.get(linkedRunId);
      if (!record) return;
      // Append the outbound reply but keep the record active — agent_end (if it
      // fires) will be the authoritative finalize. If agent_end never comes
      // (channel-only flow), we still close out here.
      if (!record.outbound) {
        const contentResult = truncateString(event.content, state.config.contentMaxBytes);
        record.outbound = {
          capturedAt: nowIso(),
          success: true,
          messages: [
            {
              role: "assistant",
              content: contentResult.value ?? "",
              to: event.to,
              ...(event.replyToId !== undefined ? { replyToId: event.replyToId } : {}),
            },
          ],
          truncated: contentResult.truncated,
        };
      }
      // If no LLM hops were captured, this is a pure channel-only flow.
      // Finalize now because no agent_end is coming.
      if (record.llmInputs.length === 0 && record.llmOutputs.length === 0) {
        finalize(
          {
            runId: record.runId,
            ...(record.sessionKey !== undefined ? { sessionKey: record.sessionKey } : {}),
          },
          (rec) => {
            rec.status = "completed";
          },
        );
      }
    });

    // ── Gated hooks: only register when both audit.enabled AND host's
    // allowConversationAccess are true. This avoids the "blocked" info log
    // OpenClaw emits when a non-bundled plugin tries to register these
    // without the explicit consent gate.
    const { auditEnabled, allowConversationAccess } = readHostAuditFlags(api);
    if (!(auditEnabled && allowConversationAccess)) {
      return;
    }

    api.on("llm_input", (event, ctx) => {
      if (!state.config.enabled) return;
      const runId = event.runId ?? ctx.runId;
      // PluginHookLlmInputEvent has `sessionId` but NOT `sessionKey` — the
      // session correlation key only exists on ctx. Don't read event.sessionId
      // here; mixing it into the sessionKey namespace pollutes bySessionKey
      // and breaks conversation grouping (the v0.6 regression decision #18
      // warned about).
      const sessionKey = ctx.sessionKey;
      if (!runId) return;
      const record = findOrCreateRecord(
        {
          runId,
          ...(sessionKey !== undefined ? { sessionKey } : {}),
        },
        {
          ...(event.sessionId
            ? { sessionId: event.sessionId }
            : ctx.sessionId
              ? { sessionId: ctx.sessionId }
              : {}),
          ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
          ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
          ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
        },
      );
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
      // Direct runId lookup is the fast path. Fall back to sessionKey if
      // the record was created via message_received (synthetic runId) and
      // before_prompt_build/llm_input hasn't promoted it yet — defensive
      // belt against any ordering edge case.
      let record = state.active.get(runId);
      if (!record && ctx.sessionKey) {
        const linkedRunId = state.bySessionKey.get(ctx.sessionKey);
        if (linkedRunId) record = state.active.get(linkedRunId);
      }
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
      finalize(
        {
          runId,
          ...(ctx.sessionKey !== undefined ? { sessionKey: ctx.sessionKey } : {}),
        },
        (record) => {
          // If message_sending already captured the actual reply that went
          // back to the sender, preserve it — agent_end.messages is a
          // snapshot of the *entire* conversation (system + user + every
          // assistant turn), so writing it into the "OpenClaw → sender"
          // slot would duplicate content the user already sees in the
          // LLM-output section. Only fall back to messages array when no
          // channel-side reply was captured.
          if (record.outbound) {
            record.outbound.success = event.success;
          } else {
            record.outbound = {
              capturedAt: nowIso(),
              success: event.success,
              messages: messages.items,
              truncated: messages.truncated,
            };
          }
          record.status = event.success ? "completed" : "error";
          if (event.error) record.errorMessage = event.error;
          if (typeof event.durationMs === "number") record.durationMs = event.durationMs;
        },
      );
    });
  };

  // Diagnostic-event fallback for Control UI and other code paths that bypass
  // the channel hook system. Builds lightweight conversation records from
  // message.queued (start) + message.processed (finalize). These records do
  // NOT contain content (no message content in these events) — but they give
  // operators visibility that a conversation happened on a particular channel.
  const ingestDiagnosticEvent: ConversationProbe["ingestDiagnosticEvent"] = (
    event,
    capturedAtMs,
  ) => {
    if (!state.config.enabled) return;
    if (event.type === "message.queued") {
      const evt = event as unknown as {
        sessionKey?: string;
        sessionId?: string;
        channel?: string;
        source?: string;
      };
      const sessionKey = evt.sessionKey;
      if (!sessionKey) return;
      // If a hook-based path is already tracking this session, don't create a
      // duplicate record from diagnostic events.
      if (state.bySessionKey.has(sessionKey)) return;
      findOrCreateRecord(
        { sessionKey },
        {
          ...(evt.sessionId !== undefined ? { sessionId: evt.sessionId } : {}),
          ...(evt.channel !== undefined ? { channelId: evt.channel } : {}),
          trigger: evt.source ? `diag:${evt.source}` : "diag:message",
          startedAt: new Date(capturedAtMs).toISOString(),
        },
      );
    } else if (event.type === "message.processed") {
      const evt = event as unknown as {
        sessionKey?: string;
        channel?: string;
        durationMs?: number;
        outcome?: "completed" | "skipped" | "error";
        error?: string;
      };
      const sessionKey = evt.sessionKey;
      if (!sessionKey) return;
      const linkedRunId = state.bySessionKey.get(sessionKey);
      if (!linkedRunId) return;
      const record = state.active.get(linkedRunId);
      if (!record) return;
      // Only finalize records that came in via diagnostic-event path
      // (trigger starts with "diag:"). Hook-driven records finalize via
      // agent_end or message_sending and shouldn't be touched here.
      if (!record.trigger?.startsWith("diag:")) return;
      finalize(
        { runId: record.runId, sessionKey },
        (rec) => {
          rec.status = evt.outcome === "error" ? "error" : "completed";
          if (evt.error) rec.errorMessage = evt.error;
          if (typeof evt.durationMs === "number") rec.durationMs = evt.durationMs;
          // No content to record. Mark this record as diagnostic-only so the
          // UI can render an informative empty state instead of pretending we
          // missed the content capture.
          rec.outbound = {
            capturedAt: nowIso(),
            success: evt.outcome !== "error",
            messages: [],
            truncated: false,
          };
        },
      );
    }
  };

  return {
    installHooks,
    ingestDiagnosticEvent,
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
      state.bySessionKey.clear();
      state.recent.length = 0;
    },
  };
}
