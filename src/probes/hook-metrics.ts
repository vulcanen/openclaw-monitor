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

function makeRunContextRegistry() {
  const ctxByRun = new Map<string, RunContextFields>();
  const evictTimers = new Map<string, NodeJS.Timeout>();

  const set = (runId: string, fields: RunContextFields): void => {
    const existing = ctxByRun.get(runId) ?? {};
    const merged: RunContextFields = { ...existing };
    if (fields.channelId !== undefined) merged.channelId = fields.channelId;
    if (fields.trigger !== undefined) merged.trigger = fields.trigger;
    ctxByRun.set(runId, merged);
    const prev = evictTimers.get(runId);
    if (prev) clearTimeout(prev);
    evictTimers.delete(runId);
  };

  const scheduleEvict = (runId: string): void => {
    const prev = evictTimers.get(runId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      ctxByRun.delete(runId);
      evictTimers.delete(runId);
    }, RUN_CTX_TTL_MS);
    timer.unref?.();
    evictTimers.set(runId, timer);
  };

  const get = (runId: string | undefined): RunContextFields | undefined => {
    if (!runId) return undefined;
    return ctxByRun.get(runId);
  };

  return { set, get, scheduleEvict };
}

export function installHookMetrics(params: {
  api: OpenClawPluginApi;
  fanout: EventFanout;
  pricing?: PricingRef;
}): void {
  const { api, fanout } = params;
  const pricing = params.pricing ?? createPricingRef();
  const runCtx = makeRunContextRegistry();
  let tokenSeq = 0;

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
    });
    // Backfill channel/trigger from the runId cache for the (rare) case
    // where the llm_output ctx doesn't carry them yet but agent_turn_prepare
    // already populated the registry.
    const enriched = { ...synth } as Record<string, unknown>;
    enrich(enriched, event.runId);
    fanout.inject(enriched as unknown as DiagnosticEventPayload);
  });

  // ── Tool execution ────────────────────────────────────────────────────────

  api.on("before_tool_call", (event, _ctx) => {
    const synth: Record<string, unknown> = {
      type: "tool.execution.started",
      toolName: event.toolName,
    };
    if (event.runId !== undefined) synth["runId"] = event.runId;
    if (event.toolCallId !== undefined) synth["toolCallId"] = event.toolCallId;
    enrich(synth, event.runId);
    fanout.inject(synth as DiagnosticEventPayload);
  });

  api.on("after_tool_call", (event, _ctx) => {
    const isError = Boolean(event.error);
    const synth: Record<string, unknown> = {
      type: isError ? "tool.execution.error" : "tool.execution.completed",
      toolName: event.toolName,
    };
    if (event.runId !== undefined) synth["runId"] = event.runId;
    if (event.toolCallId !== undefined) synth["toolCallId"] = event.toolCallId;
    if (typeof event.durationMs === "number") synth["durationMs"] = event.durationMs;
    if (event.error) synth["errorMessage"] = event.error;
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
}
