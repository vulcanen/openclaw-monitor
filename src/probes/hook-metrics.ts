import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { EventFanout } from "./event-subscriber.js";
import { buildTokenEvent } from "../costs/pricing.js";
import type { PricingConfig } from "../costs/types.js";
import { DEFAULT_PRICING_CONFIG } from "../costs/types.js";

/**
 * Pricing changes at runtime when service.start re-reads the config. Hook
 * callbacks captured the closure at install time, so we route every lookup
 * through this mutable ref instead of a captured value.
 */
export type PricingRef = {
  get: () => PricingConfig;
  set: (next: PricingConfig) => void;
};

export function createPricingRef(initial: PricingConfig = DEFAULT_PRICING_CONFIG): PricingRef {
  let current = initial;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}

/**
 * Hook-driven metrics capture.
 *
 * Diagnostic events (`model.call.*`, `tool.execution.*`, `harness.run.*`) are
 * the "natural" source for our metric rollups, but their emission is gated by
 * the host's diagnostic subsystem and varies between OpenClaw paths — Control
 * UI is known not to emit any of them, and we've seen OpenAI-compatible API
 * calls not emit them in some host configurations either.
 *
 * Plugin hooks (`model_call_started/ended`, `before_tool_call/after_tool_call`,
 * `agent_turn_prepare`, `agent_end`, `session_start/end`, `subagent_*`) are the
 * stable plugin-facing surface. Anywhere the agent harness runs, these fire.
 *
 * This probe subscribes to those hooks and **synthesizes** equivalent
 * diagnostic-event-shaped payloads, then injects them through the existing
 * fanout so the buffer, aggregator, runs-tracker, conversation-probe and bus
 * all see the activity exactly as if a diagnostic event had been emitted.
 *
 * The fanout has its own callId/toolCallId dedup so if BOTH a diagnostic event
 * and the matching hook fire for the same call, only the first is counted.
 *
 * **Hook context enrichment**: the host's hook context shape is per-hook.
 * `agent_turn_prepare` / `agent_end` ctx carries `channelId` and `trigger`,
 * but `model_call_*` and `*_tool_call` ctx do NOT (see attempt.model-
 * diagnostic-events.ts: `modelCallHookContext` only forwards runId / trace /
 * sessionKey / sessionId / modelProviderId / modelId). Without backfill,
 * downstream `channel` / `source` rollups stay empty for every model.call
 * and tool.execution event. We work around that by maintaining an
 * in-process `runId → { channelId, trigger }` map populated from
 * agent_turn_prepare / agent_end and consulted whenever a child event
 * lacks those fields. Entries are evicted shortly after agent_end since
 * model.call / tool.execution can land after the harness finalizes.
 */
type RunContextFields = { channelId?: string; trigger?: string };
const RUN_CTX_TTL_MS = 60_000;
// Outer safety-net TTL: if a run never reaches agent_end (host abort,
// process crash mid-run, harness path that skips finalize) the run's
// entry would otherwise stay in `ctxByRun` forever and slowly leak. Refresh
// the timer on each `set()` so live runs aren't evicted prematurely; the
// 30-minute window covers all practical real-runs while bounding the leak.
const RUN_CTX_MAX_TTL_MS = 30 * 60_000;

function makeRunContextRegistry() {
  const ctxByRun = new Map<string, RunContextFields>();
  const evictTimers = new Map<string, NodeJS.Timeout>();

  const scheduleEvictAt = (runId: string, ttlMs: number): void => {
    const prev = evictTimers.get(runId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      ctxByRun.delete(runId);
      evictTimers.delete(runId);
    }, ttlMs);
    timer.unref?.();
    evictTimers.set(runId, timer);
  };

  const set = (runId: string, fields: RunContextFields): void => {
    const existing = ctxByRun.get(runId) ?? {};
    const merged: RunContextFields = { ...existing };
    if (fields.channelId !== undefined) merged.channelId = fields.channelId;
    if (fields.trigger !== undefined) merged.trigger = fields.trigger;
    ctxByRun.set(runId, merged);
    // Bound the entry's lifetime even for runs that never call
    // scheduleEvict (agent_end). Refreshed on every set() so multi-turn
    // runs keep the entry alive for as long as turns keep arriving.
    scheduleEvictAt(runId, RUN_CTX_MAX_TTL_MS);
  };

  const scheduleEvict = (runId: string): void => {
    scheduleEvictAt(runId, RUN_CTX_TTL_MS);
  };

  const get = (runId: string | undefined): RunContextFields | undefined => {
    if (!runId) return undefined;
    return ctxByRun.get(runId);
  };

  return { set, get, scheduleEvict };
}

// OpenClaw's plugin loader may invoke `register(api)` multiple times per
// process (different load profiles / cache-miss re-runs — see index.ts).
// Each pass receives its own `api` object whose `api.on(...)` listeners are
// scoped to that load profile's hook registry; we *do* need to register on
// every distinct `api` so hooks fire for every registry. But if the SAME
// `api` object is passed twice (cache invalidation, hot reload, etc.) we'd
// stack a second listener on top of the first, and a single hook firing
// would inject TWO synthesized events into the fanout.
//
// For events with a callId / toolCallId the fanout's dedup absorbs the
// duplicate. But `llm.tokens.recorded` and `harness.run.*` synthesized
// here carry neither — so a duplicate listener would double-count cost
// (and tokens, and the daily-cost JSONL rollup). Guard against that by
// remembering which `api` objects we already installed on.
const installedApis = new WeakSet<OpenClawPluginApi>();

// Forward-compatible API view: hook names and ctx fields added in host 2026.5.14+
// are not yet in the 2026.5.7 published SDK types we compile against. Host
// 2026.5.7-2026.5.17 will only `warn` and ignore unknown hook names (host loader
// `registerTypedHook` returns early with a diagnostic) — never throw — so it is
// safe to register them unconditionally. See decision #59 for the full list.
type ForwardCompatPluginApi = {
  on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void;
};

export function installHookMetrics(params: {
  api: OpenClawPluginApi;
  fanout: EventFanout;
  pricing?: PricingRef;
}): void {
  const { api, fanout } = params;
  if (installedApis.has(api)) return;
  installedApis.add(api);
  const pricing = params.pricing ?? createPricingRef();
  const runCtx = makeRunContextRegistry();
  let tokenSeq = 0;
  const apiFC = api as unknown as ForwardCompatPluginApi;

  const enrich = (synth: Record<string, unknown>, runId?: string): void => {
    if (synth["channel"] !== undefined && synth["trigger"] !== undefined) return;
    const cached = runCtx.get(runId);
    if (!cached) return;
    if (synth["channel"] === undefined && cached.channelId !== undefined) {
      synth["channel"] = cached.channelId;
    }
    if (synth["trigger"] === undefined && cached.trigger !== undefined) {
      synth["trigger"] = cached.trigger;
    }
  };

  // ── Model calls ───────────────────────────────────────────────────────────

  // 2026.5.14+ adds contextTokenBudget / contextWindowSource /
  // contextWindowReferenceTokens to PluginHookModelCallBaseEvent (decision #59).
  // The fields are read defensively via cast since we still compile against
  // the 2026.5.7 SDK.
  const copyModelCallContextFields = (
    source: Record<string, unknown>,
    target: Record<string, unknown>,
  ): void => {
    if (typeof source["contextTokenBudget"] === "number") {
      target["contextTokenBudget"] = source["contextTokenBudget"];
    }
    if (typeof source["contextWindowSource"] === "string") {
      target["contextWindowSource"] = source["contextWindowSource"];
    }
    if (typeof source["contextWindowReferenceTokens"] === "number") {
      target["contextWindowReferenceTokens"] = source["contextWindowReferenceTokens"];
    }
  };

  api.on("model_call_started", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "model.call.started",
      runId: event.runId,
      callId: event.callId,
      provider: event.provider,
      model: event.model,
    };
    if (event.sessionKey !== undefined) synth["sessionKey"] = event.sessionKey;
    if (event.sessionId !== undefined) synth["sessionId"] = event.sessionId;
    if (event.api !== undefined) synth["api"] = event.api;
    if (event.transport !== undefined) synth["transport"] = event.transport;
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    if (ctx.trigger !== undefined) synth["trigger"] = ctx.trigger;
    copyModelCallContextFields(event, synth);
    enrich(synth, event.runId);
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("model_call_ended", (event, ctx) => {
    const type = event.outcome === "error" ? "model.call.error" : "model.call.completed";
    const synth: Record<string, unknown> = {
      type,
      runId: event.runId,
      callId: event.callId,
      provider: event.provider,
      model: event.model,
      durationMs: event.durationMs,
    };
    if (event.sessionKey !== undefined) synth["sessionKey"] = event.sessionKey;
    if (event.sessionId !== undefined) synth["sessionId"] = event.sessionId;
    if (event.api !== undefined) synth["api"] = event.api;
    if (event.transport !== undefined) synth["transport"] = event.transport;
    if (event.errorCategory !== undefined) synth["errorCategory"] = event.errorCategory;
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    if (ctx.trigger !== undefined) synth["trigger"] = ctx.trigger;
    copyModelCallContextFields(event, synth);
    enrich(synth, event.runId);
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── LLM output / token accounting (v0.8.0+) ────────────────────────────
  // The model_call_ended hook fires *before* the host finishes parsing the
  // assistant message, so its event doesn't carry usage data. The
  // llm_output hook is where token counts (input/output, plus optional
  // cacheRead/cacheWrite) become available — see
  // host: src/plugins/hook-types.ts: PluginHookLlmOutputEvent.
  //
  // This hook is gated by plugins.entries.openclaw-monitor.hooks
  //   .allowConversationAccess in the host config — the same security
  // gate the audit module uses. With the gate off, the host silently
  // refuses to fire the hook and cost rollups will stay at zero (token
  // counts too). The Costs page surfaces this state as a banner.
  api.on("llm_output", (event, ctx) => {
    const usage = event.usage;
    if (!usage) return;
    const input = typeof usage.input === "number" ? usage.input : 0;
    const output = typeof usage.output === "number" ? usage.output : 0;
    const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : undefined;
    const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined;
    if (input === 0 && output === 0 && !cacheRead && !cacheWrite) {
      // Some providers report zero usage when streaming without
      // include_usage; emitting a record would dilute cost trends with
      // empty entries. Skip silently.
      return;
    }
    tokenSeq += 1;
    // host 2026.5.14+ (#64327) adds context-budget + resolved-ref + harness
    // metadata to llm_output. Read defensively via cast since the compile-time
    // SDK is pinned to 2026.5.7. See decision #59 in rules/host-contract.md.
    const eventExt = event as {
      contextTokenBudget?: number;
      contextWindowSource?: "model" | "modelsConfig" | "agentContextTokens" | "default";
      contextWindowReferenceTokens?: number;
      resolvedRef?: string;
      harnessId?: string;
    };
    const synth = buildTokenEvent({
      pricing: pricing.get(),
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(ctx.sessionKey !== undefined ? { sessionKey: ctx.sessionKey } : {}),
      ...(event.provider !== undefined ? { provider: event.provider } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(ctx.channelId !== undefined ? { channel: ctx.channelId } : {}),
      ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
      usage: {
        inputTokens: input,
        outputTokens: output,
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
      },
      seq: tokenSeq,
      ...(eventExt.contextTokenBudget !== undefined
        ? { contextTokenBudget: eventExt.contextTokenBudget }
        : {}),
      ...(eventExt.contextWindowSource !== undefined
        ? { contextWindowSource: eventExt.contextWindowSource }
        : {}),
      ...(eventExt.contextWindowReferenceTokens !== undefined
        ? { contextWindowReferenceTokens: eventExt.contextWindowReferenceTokens }
        : {}),
      ...(eventExt.resolvedRef !== undefined ? { resolvedRef: eventExt.resolvedRef } : {}),
      ...(eventExt.harnessId !== undefined ? { harnessId: eventExt.harnessId } : {}),
    });
    // Backfill channel/trigger from the runId cache for the (rare) case
    // where the llm_output ctx doesn't carry them yet but agent_turn_prepare
    // already populated the registry.
    const enriched = { ...synth } as Record<string, unknown>;
    enrich(enriched, event.runId);
    fanout.inject(enriched as unknown as DiagnosticEventPayload);
  });

  // ── Tool execution ────────────────────────────────────────────────────────

  // host >= 2026.5.18 (#83387) populates channelId / sessionId / sessionKey /
  // agentId on PluginHookToolContext. We prefer those when present, then fall
  // back to the runCtx registry (decision #13) for 2026.5.7 - 2026.5.17.
  // The runId / channel writes from ctx short-circuit `enrich`'s lookups, so
  // we don't pay a Map.get() per tool call on the modern host.
  api.on("before_tool_call", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "tool.execution.started",
      toolName: event.toolName,
    };
    if (event.runId !== undefined) synth["runId"] = event.runId;
    if (event.toolCallId !== undefined) synth["toolCallId"] = event.toolCallId;
    // host >= 2026.5.18 channelId on tool ctx — see decision #59.
    const ctxExt = ctx as { channelId?: string };
    if (ctxExt.channelId !== undefined) synth["channel"] = ctxExt.channelId;
    if (ctx.sessionId !== undefined) synth["sessionId"] = ctx.sessionId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    enrich(synth, event.runId);
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("after_tool_call", (event, ctx) => {
    const isError = Boolean(event.error);
    const synth: Record<string, unknown> = {
      type: isError ? "tool.execution.error" : "tool.execution.completed",
      toolName: event.toolName,
    };
    if (event.runId !== undefined) synth["runId"] = event.runId;
    if (event.toolCallId !== undefined) synth["toolCallId"] = event.toolCallId;
    if (typeof event.durationMs === "number") synth["durationMs"] = event.durationMs;
    if (event.error) synth["errorMessage"] = event.error;
    const ctxExt = ctx as { channelId?: string };
    if (ctxExt.channelId !== undefined) synth["channel"] = ctxExt.channelId;
    if (ctx.sessionId !== undefined) synth["sessionId"] = ctx.sessionId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    enrich(synth, event.runId);
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Harness run lifecycle (synthesized from agent-turn + agent-end) ───────

  api.on("agent_turn_prepare", (_event, ctx) => {
    if (!ctx.runId) return;
    runCtx.set(ctx.runId, {
      ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
      ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
    });
    const synth: Record<string, unknown> = {
      type: "harness.run.started",
      runId: ctx.runId,
    };
    if (ctx.sessionId !== undefined) synth["sessionId"] = ctx.sessionId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    if (ctx.trigger !== undefined) synth["trigger"] = ctx.trigger;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Session lifecycle (v0.9.6) ────────────────────────────────────────
  // The host emits `session.stalled` / `session.stuck` as per-session
  // attention signals, but never an explicit "session started" / "session
  // ended" event for external plugins. session_start / session_end hooks
  // fill that gap: now Overview can show "N sessions active right now"
  // and Logs / Events surfaces who's joining and leaving with reason +
  // duration. Synthesized as `session.lifecycle.*` to keep them grouped
  // under one event-type prefix (helpful with the new Logs typePrefix
  // filter).
  api.on("session_start", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "session.lifecycle.started",
      sessionId: event.sessionId,
    };
    if (event.sessionKey !== undefined) synth["sessionKey"] = event.sessionKey;
    if (event.resumedFrom !== undefined) synth["resumedFrom"] = event.resumedFrom;
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("session_end", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "session.lifecycle.ended",
      sessionId: event.sessionId,
      messageCount: event.messageCount,
    };
    if (event.sessionKey !== undefined) synth["sessionKey"] = event.sessionKey;
    if (event.reason !== undefined) synth["reason"] = event.reason;
    if (typeof event.durationMs === "number") synth["durationMs"] = event.durationMs;
    if (event.transcriptArchived !== undefined) {
      synth["transcriptArchived"] = event.transcriptArchived;
    }
    if (event.nextSessionId !== undefined) synth["nextSessionId"] = event.nextSessionId;
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Compaction lifecycle (v0.9.6) ─────────────────────────────────────
  // before/after_compaction expose the agent's context-window pressure:
  // how often we compact, how many messages get rolled into history, and
  // (when available) the token count before vs after. This is the
  // strongest single signal of cost + quality risk — frequent compaction
  // means the agent is losing context and cost is bloating with system-
  // prompt re-injection.
  api.on("before_compaction", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "agent.compaction.started",
      messageCount: event.messageCount,
    };
    if (event.compactingCount !== undefined) synth["compactingCount"] = event.compactingCount;
    if (event.tokenCount !== undefined) synth["tokenCount"] = event.tokenCount;
    if (ctx.sessionId !== undefined) synth["sessionId"] = ctx.sessionId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("after_compaction", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "agent.compaction.completed",
      messageCount: event.messageCount,
      compactedCount: event.compactedCount,
    };
    if (event.tokenCount !== undefined) synth["tokenCount"] = event.tokenCount;
    if (ctx.sessionId !== undefined) synth["sessionId"] = ctx.sessionId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Tool result persistence (v0.9.6) ──────────────────────────────────
  // Complements after_tool_call by surfacing the *post-processing* step
  // where the tool result becomes a persisted AgentMessage. Useful to
  // detect synthetic results (host-injected without a real tool run)
  // and to spot tools that emit huge messages (output bytes correlate
  // with downstream context-window pressure).
  api.on("tool_result_persist", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "tool.result.persisted",
    };
    if (event.toolName !== undefined) synth["toolName"] = event.toolName;
    if (event.toolCallId !== undefined) synth["toolCallId"] = event.toolCallId;
    if (event.isSynthetic !== undefined) synth["isSynthetic"] = event.isSynthetic;
    // Best-effort message byte budget — the AgentMessage shape varies
    // by host version, but most fields fit JSON.stringify. Failure to
    // measure is non-fatal.
    try {
      const msg = event.message as unknown;
      const json = JSON.stringify(msg ?? null);
      synth["messageBytes"] = json.length;
    } catch {
      // ignore
    }
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Gateway lifecycle (v0.9.6) ────────────────────────────────────────
  // Cleaner "uptime / last restart" surface than inferring from the
  // replay path's reduction in event flow. The Overview page can show
  // "gateway started at <iso>" and "restart count today" using these.
  api.on("gateway_start", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "gateway.lifecycle.started",
      port: event.port,
    };
    if (ctx.workspaceDir !== undefined) synth["workspaceDir"] = ctx.workspaceDir;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("gateway_stop", (event, _ctx) => {
    const synth: Record<string, unknown> = {
      type: "gateway.lifecycle.stopped",
    };
    if (event.reason !== undefined) synth["reason"] = event.reason;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // agent_end is already used by conversation-probe for audit; we inject a
  // synthesized harness.run.completed/error here too so runs-tracker can
  // finalize the run record even when the host doesn't emit harness.run.*
  // diagnostic events.
  api.on("agent_end", (event, ctx) => {
    if (!event.runId) return;
    // Refresh & schedule eviction for the runId→ctx cache. Same runId may
    // still see late-arriving model.call/tool events for a few seconds
    // (fire-and-forget stream observers); the TTL covers that gap.
    runCtx.set(event.runId, {
      ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
      ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
    });
    runCtx.scheduleEvict(event.runId);
    const type = event.success ? "harness.run.completed" : "harness.run.error";
    const synth: Record<string, unknown> = {
      type,
      runId: event.runId,
    };
    if (typeof event.durationMs === "number") synth["durationMs"] = event.durationMs;
    if (event.error) synth["errorMessage"] = event.error;
    if (ctx.sessionId !== undefined) synth["sessionId"] = ctx.sessionId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    if (ctx.trigger !== undefined) synth["trigger"] = ctx.trigger;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Subagent lifecycle (v0.9.8) ─────────────────────────────────────────
  // Subagents are first-class in OpenClaw — every "research a topic", "edit
  // these files", or "draft a Slack reply" delegated to a child session goes
  // through these hooks. Without them, multi-agent operations look like a
  // single long agent run with no breakdown of who spawned whom or what
  // succeeded vs failed. We synthesize three event types so Logs / Events /
  // Insights can pivot on subagent activity without adding an aggregator
  // dimension (per decision #51).
  api.on("subagent_spawning", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "subagent.lifecycle.spawning",
      childSessionKey: event.childSessionKey,
      agentId: event.agentId,
      mode: event.mode,
      threadRequested: event.threadRequested,
    };
    if (event.label !== undefined) synth["label"] = event.label;
    if (event.requester?.channel !== undefined) synth["channel"] = event.requester.channel;
    if (ctx.runId !== undefined) synth["runId"] = ctx.runId;
    if (ctx.requesterSessionKey !== undefined) {
      synth["requesterSessionKey"] = ctx.requesterSessionKey;
    }
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("subagent_spawned", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "subagent.lifecycle.spawned",
      childSessionKey: event.childSessionKey,
      agentId: event.agentId,
      mode: event.mode,
      runId: event.runId,
    };
    if (event.label !== undefined) synth["label"] = event.label;
    if (event.requester?.channel !== undefined) synth["channel"] = event.requester.channel;
    if (ctx.requesterSessionKey !== undefined) {
      synth["requesterSessionKey"] = ctx.requesterSessionKey;
    }
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("subagent_ended", (event, _ctx) => {
    const isError = event.outcome === "error" || event.outcome === "timeout";
    const synth: Record<string, unknown> = {
      type: isError ? "subagent.lifecycle.error" : "subagent.lifecycle.ended",
      targetSessionKey: event.targetSessionKey,
      targetKind: event.targetKind,
      reason: event.reason,
    };
    if (event.outcome !== undefined) synth["outcome"] = event.outcome;
    if (event.error !== undefined) synth["errorMessage"] = event.error;
    if (event.runId !== undefined) synth["runId"] = event.runId;
    if (event.accountId !== undefined) synth["accountId"] = event.accountId;
    if (typeof event.endedAt === "number") synth["endedAt"] = event.endedAt;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Agent run gate / finalize / reset (v0.9.8) ─────────────────────────
  // before_agent_run is a *gate* hook — it can block runs (return an
  // InputGateDecision). We only observe; returning void leaves the run to
  // proceed normally. Pairs with agent_end so Insights can show prompt size
  // vs. final outcome.
  // host 2026.5.7 SDK doesn't declare this hook yet; subscribe via the
  // forward-compatible api view. Host 2026.5.7-2026.5.13 will warn-and-ignore.
  apiFC.on("before_agent_run", (eventU, ctxU) => {
    const event = eventU as {
      prompt?: string;
      messages?: unknown[];
      systemPrompt?: string;
      accountId?: string;
      channelId?: string;
      senderId?: string;
    };
    const ctx = ctxU as { runId?: string; sessionKey?: string };
    const synth: Record<string, unknown> = {
      type: "agent.run.starting",
      messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
      promptBytes: typeof event.prompt === "string" ? event.prompt.length : 0,
    };
    if (event.systemPrompt !== undefined) {
      synth["systemPromptBytes"] = event.systemPrompt.length;
    }
    if (event.channelId !== undefined) synth["channel"] = event.channelId;
    if (event.accountId !== undefined) synth["accountId"] = event.accountId;
    if (event.senderId !== undefined) synth["senderId"] = event.senderId;
    if (ctx.runId !== undefined) synth["runId"] = ctx.runId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });

  api.on("before_agent_finalize", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "agent.finalize.starting",
      sessionId: event.sessionId,
      stopHookActive: event.stopHookActive,
    };
    if (event.runId !== undefined) synth["runId"] = event.runId;
    if (event.turnId !== undefined) synth["turnId"] = event.turnId;
    if (event.sessionKey !== undefined) synth["sessionKey"] = event.sessionKey;
    if (event.provider !== undefined) synth["provider"] = event.provider;
    if (event.model !== undefined) synth["model"] = event.model;
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });

  api.on("before_reset", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "session.lifecycle.resetting",
      messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
    };
    if (event.reason !== undefined) synth["reason"] = event.reason;
    if (ctx.runId !== undefined) synth["runId"] = ctx.runId;
    if (ctx.sessionId !== undefined) synth["sessionId"] = ctx.sessionId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Model resolution (v0.9.8) ───────────────────────────────────────────
  // before_model_resolve fires before the harness picks a concrete model
  // for the run. event/ctx shapes vary by host version, so we inject a
  // minimal record — operators can correlate it with the model.call.started
  // event that follows.
  api.on("before_model_resolve", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "model.lifecycle.resolving",
    };
    const e = event as Record<string, unknown>;
    if (typeof e["modelRef"] === "string") synth["requestedRef"] = e["modelRef"];
    if (typeof e["agentId"] === "string") synth["agentId"] = e["agentId"];
    if (ctx.runId !== undefined) synth["runId"] = ctx.runId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });

  // ── Cron lifecycle (v0.9.8) ─────────────────────────────────────────────
  // Heartbeat / scheduled / webhook triggers (decision #57) all flow
  // through cron. Surfacing cron job lifecycle (added / removed / started /
  // finished) lets the Sessions and Logs pages show "what's about to run"
  // and "what just fired" without polling the scheduler.
  api.on("cron_changed", (event, _ctx) => {
    const synth: Record<string, unknown> = {
      type: "cron.changed",
      action: event.action,
      jobId: event.jobId,
    };
    // sessionTarget added in 2026.5.x — read defensively for 2026.5.7 SDK compile.
    const eventExt = event as { sessionTarget?: string };
    if (eventExt.sessionTarget !== undefined) synth["sessionTarget"] = eventExt.sessionTarget;
    const job = event.job as { agentId?: string; payload?: { kind?: string } } | undefined;
    if (job?.agentId !== undefined) synth["agentId"] = job.agentId;
    if (job?.payload?.kind !== undefined) synth["payloadKind"] = job.payload.kind;
    fanout.inject(synth as DiagnosticEventPayload);
  });

  // ── Heartbeat prompt contribution (v0.9.8) ──────────────────────────────
  // Heartbeat-triggered agents call this hook so plugins can inject
  // contextual hints. We observe it so the Logs page can show the rate of
  // heartbeat firings and which agent / session is generating context for
  // them.
  api.on("heartbeat_prompt_contribution", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "heartbeat.contribution",
    };
    const e = event as Record<string, unknown>;
    if (typeof e["heartbeatId"] === "string") synth["heartbeatId"] = e["heartbeatId"];
    if (typeof e["channel"] === "string") synth["channel"] = e["channel"];
    if (ctx.runId !== undefined) synth["runId"] = ctx.runId;
    if (ctx.sessionKey !== undefined) synth["sessionKey"] = ctx.sessionKey;
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });

  // ── Message-pipeline observability (v0.9.8) ─────────────────────────────
  // inbound_claim / before_dispatch / reply_dispatch let other plugins
  // short-circuit the message pipeline. We only observe (return void). The
  // events join Logs / Events for replay; we do NOT add aggregator
  // dimensions because channel-side message metrics (message.queued /
  // delivered) are already accounted for elsewhere.
  api.on("inbound_claim", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "inbound.claim.attempt",
    };
    const e = event as Record<string, unknown>;
    if (typeof e["content"] === "string") synth["contentBytes"] = e["content"].length;
    if (typeof e["sessionKey"] === "string") synth["sessionKey"] = e["sessionKey"];
    if (ctx.channelId !== undefined) synth["channel"] = ctx.channelId;
    if (ctx.accountId !== undefined) synth["accountId"] = ctx.accountId;
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });

  api.on("before_dispatch", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "message.dispatch.before",
      contentBytes: typeof event.content === "string" ? event.content.length : 0,
    };
    if (event.channel !== undefined) synth["channel"] = event.channel;
    if (event.sessionKey !== undefined) synth["sessionKey"] = event.sessionKey;
    if (event.isGroup !== undefined) synth["isGroup"] = event.isGroup;
    if (ctx.channelId !== undefined && synth["channel"] === undefined) {
      synth["channel"] = ctx.channelId;
    }
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });

  api.on("reply_dispatch", (event, _ctx) => {
    const synth: Record<string, unknown> = {
      type: "message.dispatch.reply",
      sendPolicy: event.sendPolicy,
      inboundAudio: event.inboundAudio,
      shouldRouteToOriginating: event.shouldRouteToOriginating,
    };
    if (event.runId !== undefined) synth["runId"] = event.runId;
    if (event.sessionKey !== undefined) synth["sessionKey"] = event.sessionKey;
    if (event.originatingChannel !== undefined) synth["channel"] = event.originatingChannel;
    if (event.ttsChannel !== undefined) synth["ttsChannel"] = event.ttsChannel;
    if (typeof event.isTailDispatch === "boolean") synth["isTailDispatch"] = event.isTailDispatch;
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });

  api.on("before_message_write", (event, ctx) => {
    const synth: Record<string, unknown> = {
      type: "message.write.before",
    };
    const e = event as Record<string, unknown>;
    if (typeof e["role"] === "string") synth["role"] = e["role"];
    if (typeof e["sessionKey"] === "string") synth["sessionKey"] = e["sessionKey"];
    if (ctx.sessionKey !== undefined && synth["sessionKey"] === undefined) {
      synth["sessionKey"] = ctx.sessionKey;
    }
    if (ctx.agentId !== undefined) synth["agentId"] = ctx.agentId;
    fanout.inject(synth as DiagnosticEventPayload);
    return undefined;
  });
}
