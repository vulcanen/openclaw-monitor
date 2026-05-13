import { describe, expect, it } from "vitest";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createAggregator } from "../pipeline/aggregator.js";
import { createRunsTracker } from "../pipeline/runs-tracker.js";
import { createEventBus } from "../outlets/event-bus.js";
import { createEventBuffer } from "../storage/ring-buffer.js";
import { createStoreRef } from "../storage/store-ref.js";
import { makeEvent } from "../test-utils.js";

describe("hook metrics probe", () => {
  type CapturedHandlers = Record<string, (event: unknown, ctx: unknown) => unknown>;
  const makeFakeApi = (handlers: CapturedHandlers) => ({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[name] = handler;
    },
  });

  it("synthesizes model.call events from hook into aggregator", async () => {
    const { installHookMetrics } = await import("./hook-metrics.js");
    const { createEventFanout } = await import("./event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("../audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });
    const handlers: CapturedHandlers = {};
    installHookMetrics({ api: makeFakeApi(handlers) as never, fanout });

    // The host's hook ctx carries `trigger` alongside channelId — we add
    // it here so the source classifier (v0.8.1+: trigger-aware) maps
    // webchat + user → "openai-api" the same way real OpenAI-compat
    // traffic does.
    handlers["model_call_started"]?.(
      { runId: "r1", callId: "c1", provider: "openai", model: "gpt-4" },
      { channelId: "webchat", trigger: "user" },
    );
    handlers["model_call_ended"]?.(
      {
        runId: "r1",
        callId: "c1",
        provider: "openai",
        model: "gpt-4",
        durationMs: 220,
        outcome: "completed",
      },
      { channelId: "webchat", trigger: "user" },
    );

    const models = aggregator.models();
    expect(models[0]?.key).toBe("openai/gpt-4");
    expect(models[0]?.total).toBe(1);
    expect(models[0]?.errors).toBe(0);
    const sources = aggregator.sources();
    expect(sources.find((s) => s.key === "openai-api")).toBeDefined();
  });

  it("dedupes when both diagnostic event and hook fire for the same callId", async () => {
    const { installHookMetrics } = await import("./hook-metrics.js");
    const { createEventFanout } = await import("./event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("../audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });
    const handlers: CapturedHandlers = {};
    installHookMetrics({ api: makeFakeApi(handlers) as never, fanout });

    // Diagnostic event arrives first
    fanout.inject(
      makeEvent("model.call.completed", {
        runId: "r2",
        callId: "c2",
        provider: "anthropic",
        model: "claude-3",
        durationMs: 150,
      }),
    );
    // Hook fires after — should be deduped
    handlers["model_call_ended"]?.(
      {
        runId: "r2",
        callId: "c2",
        provider: "anthropic",
        model: "claude-3",
        durationMs: 150,
        outcome: "completed",
      },
      {},
    );

    const models = aggregator.models();
    const row = models.find((m) => m.key === "anthropic/claude-3");
    expect(row?.total).toBe(1); // not 2
  });

  it("hook synthesis works even though onDiagnosticEvent never sees Pi-emitted model.call events", async () => {
    // This test documents the architectural fact that OpenClaw's
    // onDiagnosticEvent listener filters out all `metadata.trusted` events
    // (diagnostic-events.ts:803-810). Pi runtime emits model.call.* via
    // emitTrustedDiagnosticEvent, so external plugins NEVER see them on the
    // diagnostic event bus. Hook-based capture is the only way.
    const { installHookMetrics } = await import("./hook-metrics.js");
    const { createEventFanout } = await import("./event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("../audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });
    const handlers: CapturedHandlers = {};
    installHookMetrics({ api: makeFakeApi(handlers) as never, fanout });

    // Simulate Pi runtime: hooks fire, diagnostic event bus stays silent
    // (because Pi uses emitTrustedDiagnosticEvent which onDiagnosticEvent drops)
    handlers["agent_turn_prepare"]?.(
      {},
      { runId: "pi-run-1", sessionId: "s1", channelId: "ark-hxapi" },
    );
    handlers["model_call_started"]?.(
      { runId: "pi-run-1", callId: "pi-call-1", provider: "ark-hxapi", model: "qwen3.5" },
      { runId: "pi-run-1", channelId: "ark-hxapi" },
    );
    handlers["model_call_ended"]?.(
      {
        runId: "pi-run-1",
        callId: "pi-call-1",
        provider: "ark-hxapi",
        model: "qwen3.5",
        durationMs: 540,
        outcome: "completed",
      },
      { runId: "pi-run-1", channelId: "ark-hxapi" },
    );
    handlers["agent_end"]?.(
      { runId: "pi-run-1", messages: [], success: true, durationMs: 600 },
      { runId: "pi-run-1", channelId: "ark-hxapi" },
    );

    // Metrics populated even without ANY diagnostic events
    expect(aggregator.models()[0]?.key).toBe("ark-hxapi/qwen3.5");
    expect(aggregator.models()[0]?.total).toBe(1);
    expect(aggregator.windows()["5m"].modelCalls).toBe(1);
    // Run finalized via synthesized harness.run.completed
    expect(runsTracker.recent().some((r) => r.runId === "pi-run-1")).toBe(true);
  });

  // Regression for v0.9.6 critical fix: passing the same `api` object to
  // installHookMetrics twice must not register the handler twice. If it
  // did, `llm_output` (and similar hooks with no callId / toolCallId) would
  // fire N synthesized `llm.tokens.recorded` events per real llm_output and
  // the aggregator + daily-cost store would N×-count cost and tokens.
  it("installHookMetrics is idempotent on the same api object", async () => {
    const { installHookMetrics } = await import("./hook-metrics.js");
    const { createEventFanout } = await import("./event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("../audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });
    // Count how many distinct listeners get registered for `llm_output`
    // across both install calls. A correctly idempotent install registers
    // exactly one regardless of how many install passes happen.
    const llmOutputListeners: Array<(e: unknown, c: unknown) => unknown> = [];
    const api: { on: (n: string, h: (e: unknown, c: unknown) => unknown) => void } = {
      on: (name, handler) => {
        if (name === "llm_output") llmOutputListeners.push(handler);
      },
    };
    installHookMetrics({ api: api as never, fanout });
    installHookMetrics({ api: api as never, fanout });
    expect(llmOutputListeners).toHaveLength(1);
  });

  // Belt-and-suspenders dedup: even if the listener is registered twice
  // somehow (different api with shared state, etc.), the fanout's
  // (runId, seq) dedup on `llm.tokens.recorded` should ensure aggregator
  // counts the event only once.
  it("llm.tokens.recorded with same (runId, seq) is deduped at the fanout", async () => {
    const { createEventFanout } = await import("./event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("../audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });
    const tokenEvent = {
      type: "llm.tokens.recorded",
      runId: "r-tok-1",
      seq: 42,
      provider: "openai",
      model: "gpt-4",
      inputTokens: 100,
      outputTokens: 200,
      cost: 0.01,
    } as unknown as DiagnosticEventPayload;
    fanout.inject(tokenEvent);
    fanout.inject(tokenEvent); // duplicate — must be dropped
    const row = aggregator.models().find((m) => m.key === "openai/gpt-4");
    // Without dedup, tokensIn would be 200 and cost 0.02.
    expect(row?.tokensIn).toBe(100);
    expect(row?.cost).toBe(0.01);
  });

  it("synthesizes tool.execution events from hook", async () => {
    const { installHookMetrics } = await import("./hook-metrics.js");
    const { createEventFanout } = await import("./event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("../audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });
    const handlers: CapturedHandlers = {};
    installHookMetrics({ api: makeFakeApi(handlers) as never, fanout });

    handlers["before_tool_call"]?.(
      { toolName: "shell", params: {}, runId: "r3", toolCallId: "t1" },
      {},
    );
    handlers["after_tool_call"]?.(
      {
        toolName: "shell",
        params: {},
        runId: "r3",
        toolCallId: "t1",
        durationMs: 18,
      },
      {},
    );

    const tools = aggregator.tools();
    expect(tools[0]?.key).toBe("shell");
    expect(tools[0]?.total).toBe(1);
  });
});
