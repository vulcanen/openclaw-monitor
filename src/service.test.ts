import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBuffer } from "./storage/ring-buffer.js";
import { createJsonlStore } from "./storage/jsonl-store.js";
import { createAggregator } from "./pipeline/aggregator.js";
import { createRunsTracker } from "./pipeline/runs-tracker.js";
import { createEventBus } from "./outlets/event-bus.js";
import { createEventFanout } from "./probes/event-subscriber.js";
import { createStoreRef } from "./storage/store-ref.js";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

function makeEvent<T extends DiagnosticEventPayload["type"]>(
  type: T,
  extra: Record<string, unknown> = {},
): DiagnosticEventPayload {
  return { type, seq: 0, ts: Date.now(), ...extra } as unknown as DiagnosticEventPayload;
}

describe("event buffer", () => {
  it("retains events up to maxPerType per type", () => {
    const buffer = createEventBuffer({ maxPerType: 3 });
    for (let i = 0; i < 10; i += 1) {
      buffer.append(makeEvent("tool.execution.completed"));
    }
    expect(buffer.size()).toBe(3);
    expect(buffer.countsByType()["tool.execution.completed"]).toBe(10);
  });

  it("filters by type when requested", () => {
    const buffer = createEventBuffer({ maxPerType: 10 });
    buffer.append(makeEvent("model.call.completed"));
    buffer.append(makeEvent("tool.execution.completed"));
    buffer.append(makeEvent("model.call.completed"));
    expect(buffer.recent({ type: "model.call.completed" })).toHaveLength(2);
    expect(buffer.recent({ type: "tool.execution.completed" })).toHaveLength(1);
  });
});

describe("aggregator", () => {
  it("rolls up dimensions per provider/model", () => {
    const agg = createAggregator();
    const now = Date.now();
    agg.ingest(
      makeEvent("model.call.completed", {
        provider: "openai",
        model: "gpt-4",
        durationMs: 120,
        tokensIn: 100,
        tokensOut: 200,
      }),
      now,
    );
    agg.ingest(
      makeEvent("model.call.error", {
        provider: "openai",
        model: "gpt-4",
        durationMs: 800,
      }),
      now,
    );
    const models = agg.models();
    expect(models[0]?.key).toBe("openai/gpt-4");
    expect(models[0]?.total).toBe(2);
    expect(models[0]?.errors).toBe(1);
    expect(models[0]?.tokensIn).toBe(100);
    expect(models[0]?.tokensOut).toBe(200);
  });

  it("rolls up per-channel message stats", () => {
    const agg = createAggregator();
    const now = Date.now();
    agg.ingest(
      makeEvent("message.delivery.completed", { channel: "telegram", durationMs: 30 }),
      now,
    );
    agg.ingest(
      makeEvent("message.delivery.error", { channel: "telegram", durationMs: 50 }),
      now,
    );
    const channels = agg.channels();
    expect(channels[0]?.key).toBe("telegram");
    expect(channels[0]?.total).toBe(2);
    expect(channels[0]?.errors).toBe(1);
  });

  it("rolls up tool execution stats", () => {
    const agg = createAggregator();
    const now = Date.now();
    agg.ingest(
      makeEvent("tool.execution.completed", { toolName: "shell", durationMs: 10 }),
      now,
    );
    agg.ingest(
      makeEvent("tool.execution.blocked", { toolName: "shell" }),
      now,
    );
    const tools = agg.tools();
    expect(tools[0]?.key).toBe("shell");
    expect(tools[0]?.total).toBe(2);
    expect(tools[0]?.errors).toBe(1);
  });

  it("computes 1m / 5m / 15m / 1h windows", () => {
    const agg = createAggregator();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      agg.ingest(makeEvent("model.call.completed"), now);
    }
    agg.ingest(makeEvent("model.call.error"), now);
    const windows = agg.windows();
    expect(windows["1m"].modelCalls).toBe(6);
    expect(windows["1m"].modelErrors).toBe(1);
    expect(windows["1h"].modelCalls).toBe(6);
  });

  it("produces series buckets", () => {
    const agg = createAggregator();
    const now = Date.now();
    agg.ingest(makeEvent("model.call.completed"), now);
    const series = agg.series({ metric: "model.calls", windowSec: 300 });
    expect(series.metric).toBe("model.calls");
    expect(series.points.length).toBeGreaterThan(0);
  });
});

describe("runs tracker", () => {
  it("transitions started → completed and counts model + tool calls", () => {
    const tracker = createRunsTracker();
    const start = Date.now();
    tracker.ingest(
      makeEvent("harness.run.started", { runId: "r1", channel: "telegram" }),
      start,
    );
    tracker.ingest(
      makeEvent("model.call.completed", { runId: "r1", model: "gpt-4" }),
      start + 10,
    );
    tracker.ingest(
      makeEvent("tool.execution.completed", { runId: "r1", toolName: "shell" }),
      start + 20,
    );
    const finalSnap = tracker.ingest(
      makeEvent("harness.run.completed", { runId: "r1" }),
      start + 50,
    );
    expect(finalSnap?.status).toBe("completed");
    expect(finalSnap?.durationMs).toBe(50);
    expect(finalSnap?.modelCalls).toBe(1);
    expect(finalSnap?.toolExecs).toBe(1);
    expect(tracker.active()).toHaveLength(0);
    expect(tracker.recent()).toHaveLength(1);
  });

  it("captures error events as terminal status", () => {
    const tracker = createRunsTracker();
    tracker.ingest(makeEvent("harness.run.started", { runId: "r2" }), 0);
    const finalSnap = tracker.ingest(
      makeEvent("harness.run.error", { runId: "r2", errorMessage: "boom" }),
      100,
    );
    expect(finalSnap?.status).toBe("error");
    expect(finalSnap?.errorMessage).toBe("boom");
  });
});

describe("jsonl store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-monitor-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends and reads events back", () => {
    const store = createJsonlStore(dir);
    const now = Date.now();
    store.appendEvent(makeEvent("model.call.completed", { model: "x" }), now);
    store.appendEvent(makeEvent("model.call.error", { model: "y" }), now + 1);
    store.close();
    const reread = createJsonlStore(dir);
    const all = reread.readEvents({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all[0]?.event.type).toBe("model.call.completed");
    const errors = reread.readEvents({ limit: 10, type: "model.call.error" });
    expect(errors).toHaveLength(1);
    reread.close();
  });

  it("appends and reads runs", () => {
    const store = createJsonlStore(dir);
    store.appendRun({
      runId: "abc",
      status: "completed",
      startedAt: new Date().toISOString(),
      modelCalls: 1,
      toolExecs: 0,
    });
    const runs = store.readRuns({ limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("abc");
    store.close();
  });

  it("prunes runs older than retention window", () => {
    const store = createJsonlStore(dir);
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    store.appendRun({ runId: "old", status: "completed", startedAt: old, modelCalls: 0, toolExecs: 0 });
    store.appendRun({ runId: "fresh", status: "completed", startedAt: fresh, modelCalls: 0, toolExecs: 0 });
    const result = store.pruneOlderThan({ eventsDays: 7, runsDays: 30 });
    expect(result.runsTrimmed).toBe(1);
    const remaining = store.readRuns({ limit: 10 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.runId).toBe("fresh");
    store.close();
  });
});

describe("hook metrics probe", () => {
  type CapturedHandlers = Record<string, (event: unknown, ctx: unknown) => unknown>;
  const makeFakeApi = (handlers: CapturedHandlers) => ({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[name] = handler;
    },
  });

  it("synthesizes model.call events from hook into aggregator", async () => {
    const { installHookMetrics } = await import("./probes/hook-metrics.js");
    const { createEventFanout } = await import("./probes/event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("./audit/conversation-probe.js")).createConversationProbe();
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

    handlers["model_call_started"]?.(
      { runId: "r1", callId: "c1", provider: "openai", model: "gpt-4" },
      { channelId: "webchat" },
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
      { channelId: "webchat" },
    );

    const models = aggregator.models();
    expect(models[0]?.key).toBe("openai/gpt-4");
    expect(models[0]?.total).toBe(1);
    expect(models[0]?.errors).toBe(0);
    const sources = aggregator.sources();
    expect(sources.find((s) => s.key === "openai-api")).toBeDefined();
  });

  it("dedupes when both diagnostic event and hook fire for the same callId", async () => {
    const { installHookMetrics } = await import("./probes/hook-metrics.js");
    const { createEventFanout } = await import("./probes/event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("./audit/conversation-probe.js")).createConversationProbe();
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
    const { installHookMetrics } = await import("./probes/hook-metrics.js");
    const { createEventFanout } = await import("./probes/event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("./audit/conversation-probe.js")).createConversationProbe();
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
    handlers["agent_turn_prepare"]?.({}, { runId: "pi-run-1", sessionId: "s1", channelId: "ark-hxapi" });
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

  it("synthesizes tool.execution events from hook", async () => {
    const { installHookMetrics } = await import("./probes/hook-metrics.js");
    const { createEventFanout } = await import("./probes/event-subscriber.js");
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("./audit/conversation-probe.js")).createConversationProbe();
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

describe("plugin entry idempotency", () => {
  // Regression: OpenClaw's plugin loader can re-enter `register(api)` more
  // than once per process (different load profiles trigger fresh loads with
  // the cache miss path). When it does, the underlying state must stay
  // shared — otherwise the second pass builds its own empty bundle, hook
  // callbacks land there, and the HTTP handlers (still pointing at the first
  // bundle) see no metrics. This was the v0.5.0 → v0.5.1 silent-monitor bug.
  it("multiple register(api) calls share one bundle and don't double-register routes", async () => {
    type Registered = {
      services: unknown[];
      routes: unknown[];
      hooks: string[];
    };
    const makeFakeApi = (reg: Registered) => ({
      registerService: (svc: unknown) => {
        reg.services.push(svc);
      },
      registerHttpRoute: (route: unknown) => {
        reg.routes.push(route);
      },
      on: (name: string) => {
        reg.hooks.push(name);
      },
      registerCommand: () => {},
      registerCli: () => {},
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "openclaw-monitor": {
                  hooks: { allowConversationAccess: true },
                  config: { audit: { enabled: true } },
                },
              },
              allow: ["openclaw-monitor"],
            },
          }),
        },
      },
    });
    // Force a fresh import so the module-level singletons start clean.
    vi.resetModules();
    const entryModule = await import("./index.js");
    const entry = entryModule.default;
    const apiA: Registered = { services: [], routes: [], hooks: [] };
    const apiB: Registered = { services: [], routes: [], hooks: [] };
    entry.register(makeFakeApi(apiA));
    entry.register(makeFakeApi(apiB));
    // Service + HTTP routes + CLI commands are wired exactly once (against
    // the first api). Re-registering them on the second api would either
    // fail at runtime or duplicate paths under the host's route table.
    expect(apiA.services.length).toBe(1);
    expect(apiA.routes.length).toBeGreaterThan(0);
    expect(apiB.services.length).toBe(0);
    expect(apiB.routes.length).toBe(0);
    // Hook callbacks ARE registered on every api. The host's hook dispatcher
    // for the second-pass load profile only sees handlers attached to its
    // own api instance; we let the fanout's callId/toolCallId dedup absorb
    // the resulting duplicate injections.
    expect(apiA.hooks.length).toBeGreaterThan(0);
    expect(apiB.hooks).toEqual(apiA.hooks);
  });
});

describe("event fanout", () => {
  it("propagates an injected event to buffer + aggregator + bus + store", async () => {
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("./audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });

    let busHits = 0;
    bus.subscribe(() => {
      busHits += 1;
    });

    fanout.inject(
      makeEvent("model.call.completed", { provider: "openai", model: "gpt-4", durationMs: 50 }),
    );
    expect(buffer.size()).toBe(1);
    expect(aggregator.models()[0]?.total).toBe(1);
    expect(busHits).toBe(1);
  });
});

describe("conversation probe", () => {
  type CapturedHandlers = Record<string, (event: unknown, ctx: unknown) => unknown>;

  const makeFakeApi = (
    handlers: CapturedHandlers,
    hostFlags: { auditEnabled?: boolean; allowConversationAccess?: boolean } = {},
  ) => {
    const audit = hostFlags.auditEnabled ?? true;
    const allow = hostFlags.allowConversationAccess ?? true;
    return {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[name] = handler;
      },
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "openclaw-monitor": {
                  hooks: { allowConversationAccess: allow },
                  config: { audit: { enabled: audit } },
                },
              },
            },
          }),
        },
      },
    };
  };

  it("ignores hook calls when disabled", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);
    handlers["llm_input"]?.(
      { runId: "r1", sessionId: "s1", provider: "p", model: "m", prompt: "hi", historyMessages: [], imagesCount: 0 },
      { runId: "r1" },
    );
    handlers["agent_end"]?.({ runId: "r1", messages: [], success: true }, { runId: "r1" });
    expect(probe.activeCount()).toBe(0);
    expect(probe.recentCompleted()).toHaveLength(0);
  });

  it("does not register conversation hooks when host gates are off", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers, { allowConversationAccess: false }) as never);
    // before_prompt_build is non-gated, should always register
    expect(typeof handlers["before_prompt_build"]).toBe("function");
    // gated hooks should NOT register
    expect(handlers["llm_input"]).toBeUndefined();
    expect(handlers["llm_output"]).toBeUndefined();
    expect(handlers["agent_end"]).toBeUndefined();
  });

  it("does not register conversation hooks when audit is disabled in plugin config", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers, { auditEnabled: false }) as never);
    expect(typeof handlers["before_prompt_build"]).toBe("function");
    expect(handlers["llm_input"]).toBeUndefined();
  });

  it("accumulates 4 touchpoints and finalizes on agent_end", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: true,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    handlers["before_prompt_build"]?.(
      { prompt: "hello world", messages: [{ role: "user", content: "earlier" }] },
      { runId: "r1", sessionId: "s1", channelId: "openai", trigger: "openai-compat" },
    );
    expect(probe.activeCount()).toBe(1);

    handlers["llm_input"]?.(
      {
        runId: "r1",
        sessionId: "s1",
        provider: "openai",
        model: "gpt-4",
        systemPrompt: "you are helpful",
        prompt: "hello world",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "r1" },
    );
    handlers["llm_output"]?.(
      {
        runId: "r1",
        sessionId: "s1",
        provider: "openai",
        model: "gpt-4",
        assistantTexts: ["hi there"],
        usage: { input: 10, output: 5 },
      },
      { runId: "r1" },
    );
    handlers["agent_end"]?.(
      { runId: "r1", messages: [{ role: "assistant", content: "hi there" }], success: true, durationMs: 120 },
      { runId: "r1" },
    );

    expect(probe.activeCount()).toBe(0);
    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    const record = completed[0];
    expect(record?.inbound?.prompt).toBe("hello world");
    expect(record?.llmInputs).toHaveLength(1);
    expect(record?.llmInputs[0]?.systemPrompt).toBe("you are helpful");
    expect(record?.llmOutputs).toHaveLength(1);
    expect(record?.llmOutputs[0]?.assistantTexts).toEqual(["hi there"]);
    expect(record?.outbound?.success).toBe(true);
    expect(record?.status).toBe("completed");
    expect(record?.durationMs).toBe(120);
  });

  it("omits system prompt when captureSystemPrompt is false", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    handlers["llm_input"]?.(
      {
        runId: "r2",
        sessionId: "s2",
        provider: "openai",
        model: "gpt-4",
        systemPrompt: "secret system",
        prompt: "ask",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "r2" },
    );
    handlers["agent_end"]?.({ runId: "r2", messages: [], success: true }, { runId: "r2" });
    const record = probe.recentCompleted()[0];
    expect(record?.llmInputs[0]?.systemPrompt).toBeUndefined();
  });

  it("truncates long content beyond contentMaxBytes", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 64,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    const big = "x".repeat(500);
    handlers["llm_input"]?.(
      {
        runId: "r3",
        sessionId: "s3",
        provider: "openai",
        model: "gpt-4",
        prompt: big,
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "r3" },
    );
    handlers["agent_end"]?.({ runId: "r3", messages: [], success: true }, { runId: "r3" });
    const record = probe.recentCompleted()[0];
    expect(record?.llmInputs[0]?.prompt.length).toBeLessThan(big.length);
    expect(record?.llmInputs[0]?.truncated).toBe(true);
  });

  it("captures Control-UI style flow via message_received + message_sending alone", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    // Simulate a Control UI message: only channel-side message_received/sending fire,
    // no before_prompt_build / llm_input / agent_end.
    handlers["message_received"]?.(
      { from: "user", content: "查一下订单", sessionKey: "s-control-1" },
      { channelId: "control-ui", sessionKey: "s-control-1" },
    );
    handlers["message_sending"]?.(
      { to: "user", content: "今天有 5 笔订单。" },
      { channelId: "control-ui", sessionKey: "s-control-1" },
    );

    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.inbound?.prompt).toBe("查一下订单");
    const out = completed[0]?.outbound?.messages?.[0] as { content?: string };
    expect(out?.content).toBe("今天有 5 笔订单。");
    expect(completed[0]?.llmInputs).toHaveLength(0);
    expect(completed[0]?.trigger).toBe("channel-message");
  });

  it("captures Control-UI-style flow from message.queued + message.processed diagnostic events", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    // Diagnostic-event path: no hooks involved — Control UI doesn't fire
    // message_received/sending nor before_prompt_build.
    const queued = makeEvent("message.queued", {
      sessionKey: "ctrl-session-1",
      channel: "dashboard",
      source: "control-ui",
    });
    const processed = makeEvent("message.processed", {
      sessionKey: "ctrl-session-1",
      channel: "dashboard",
      durationMs: 420,
      outcome: "completed",
    });
    probe.ingestDiagnosticEvent(queued, Date.now());
    probe.ingestDiagnosticEvent(processed, Date.now() + 420);
    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.channelId).toBe("dashboard");
    expect(completed[0]?.trigger).toBe("diag:control-ui");
    expect(completed[0]?.status).toBe("completed");
    expect(completed[0]?.durationMs).toBe(420);
  });

  it("does not duplicate-record sessions that already have a hook-driven conversation", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);
    // Hook fires first (channel plugin path)
    handlers["message_received"]?.(
      { from: "user", content: "hi", sessionKey: "hybrid-1" },
      { channelId: "telegram", sessionKey: "hybrid-1" },
    );
    expect(probe.activeCount()).toBe(1);
    // Now diagnostic event arrives for the same session — should be ignored
    probe.ingestDiagnosticEvent(
      makeEvent("message.queued", {
        sessionKey: "hybrid-1",
        channel: "telegram",
        source: "channel",
      }),
      Date.now(),
    );
    // Still just one record, not duplicated
    expect(probe.activeCount()).toBe(1);
  });

  it("merges message_received with later before_prompt_build/llm_input via sessionKey", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    // 1. channel message arrives (only sessionKey, no runId yet)
    handlers["message_received"]?.(
      { from: "user", content: "hi", sessionKey: "s-merge-1" },
      { channelId: "control-ui", sessionKey: "s-merge-1" },
    );
    expect(probe.activeCount()).toBe(1);

    // 2. agent harness starts with real runId, same sessionKey
    handlers["before_prompt_build"]?.(
      { prompt: "hi", messages: [] },
      { runId: "real-run-1", sessionKey: "s-merge-1" },
    );
    // Should still be 1 record (merged via sessionKey), not 2
    expect(probe.activeCount()).toBe(1);

    handlers["llm_input"]?.(
      {
        runId: "real-run-1",
        sessionId: "s-merge-1",
        provider: "openai",
        model: "gpt-4",
        prompt: "hi",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "real-run-1", sessionKey: "s-merge-1" },
    );
    handlers["agent_end"]?.(
      { runId: "real-run-1", messages: [], success: true },
      { runId: "real-run-1", sessionKey: "s-merge-1" },
    );

    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.llmInputs).toHaveLength(1);
  });

  it("persists a completed conversation to the store", async () => {
    const { createConversationProbe } = await import("./audit/conversation-probe.js");
    const { createConversationStore } = await import("./audit/conversation-store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-test-"));
    try {
      const store = createConversationStore(dir);
      const probe = createConversationProbe();
      probe.setConfig({
        enabled: true,
        contentMaxBytes: 1024,
        retainDays: 3,
        captureSystemPrompt: false,
      });
      probe.setStore(store);
      const handlers: CapturedHandlers = {};
      probe.installHooks(makeFakeApi(handlers) as never);

      handlers["llm_input"]?.(
        {
          runId: "rp",
          sessionId: "sp",
          provider: "openai",
          model: "gpt-4",
          prompt: "hi",
          historyMessages: [],
          imagesCount: 0,
        },
        { runId: "rp" },
      );
      handlers["agent_end"]?.({ runId: "rp", messages: [], success: true }, { runId: "rp" });

      const persisted = store.list({ limit: 10 });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.runId).toBe("rp");
      const full = store.get("rp");
      expect(full?.llmInputs[0]?.prompt).toBe("hi");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("alert engine (v0.7)", () => {
  const setup = async () => {
    const { createAggregator } = await import("./pipeline/aggregator.js");
    const { createAlertEngine } = await import("./alerts/engine.js");
    const { DEFAULT_ALERTS_CONFIG } = await import("./alerts/types.js");
    const aggregator = createAggregator();
    return { aggregator, createAlertEngine, DEFAULT_ALERTS_CONFIG };
  };

  // Replace global fetch with a recorder so dispatcher integration runs end-
  // to-end without actually hitting the network. We assert the rule lifecycle
  // through the recorded call list.
  const installFetchRecorder = () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const original = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return {
      calls,
      restore: () => {
        (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
      },
    };
  };

  it("fires once when a metric crosses the threshold and stays quiet during cooldown", async () => {
    const { aggregator, createAlertEngine } = await setup();
    // Force the aggregator into "10 model errors in 5m": ingest 10 error events.
    for (let i = 0; i < 10; i += 1) {
      aggregator.ingest(
        makeEvent("model.call.error", { errorCategory: "rate-limit" }),
        Date.now(),
      );
    }
    const recorder = installFetchRecorder();
    const engine = createAlertEngine({
      aggregator,
      initialConfig: {
        enabled: true,
        evaluationIntervalSec: 30,
        channels: { hook: { kind: "webhook", url: "https://example.test/hook" } },
        rules: [
          {
            id: "r1",
            name: "errors high",
            metric: "modelErrors",
            window: "5m",
            op: ">",
            threshold: 5,
            channels: ["hook"],
            cooldownSec: 600,
          },
        ],
      },
    });
    try {
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(1);
      expect(recorder.calls).toHaveLength(1);
      const first = recorder.calls[0]?.body as { type: string };
      expect(first?.type).toBe("fired");

      // Second cycle within cooldown: re-evaluation must NOT re-notify.
      await engine.evaluateNow();
      expect(recorder.calls).toHaveLength(1);
    } finally {
      recorder.restore();
    }
  });

  it("emits a resolved event when the metric goes back under threshold", async () => {
    const { aggregator, createAlertEngine } = await setup();
    for (let i = 0; i < 10; i += 1) {
      aggregator.ingest(makeEvent("model.call.error"), Date.now());
    }
    const recorder = installFetchRecorder();
    const engine = createAlertEngine({
      aggregator,
      initialConfig: {
        enabled: true,
        evaluationIntervalSec: 30,
        channels: { hook: { kind: "webhook", url: "https://example.test/hook" } },
        rules: [
          {
            id: "r1",
            name: "errors high",
            metric: "modelErrors",
            window: "1h",
            op: ">",
            threshold: 5,
            channels: ["hook"],
            cooldownSec: 600,
          },
        ],
      },
    });
    try {
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(1);
      // Reset aggregator state so the metric drops to 0.
      aggregator.reset();
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(0);
      const types = recorder.calls.map((c) => (c.body as { type: string }).type);
      expect(types).toEqual(["fired", "resolved"]);
      const hist = engine.history.list();
      const histTypes = hist.map((h) => h.type);
      expect(histTypes).toContain("fired");
      expect(histTypes).toContain("resolved");
    } finally {
      recorder.restore();
    }
  });

  it("dingtalk channel signs the request when a secret is configured", async () => {
    const { __testing } = await import("./alerts/channels/dingtalk.js");
    const url = "https://oapi.dingtalk.com/robot/send?access_token=abc";
    const signed = __testing.signRequest(url, "SEC_test_secret");
    expect(signed).toMatch(/&timestamp=\d+/);
    expect(signed).toMatch(/&sign=/);
    // sign is URL-encoded base64; can't be empty.
    const signValue = new URL(signed).searchParams.get("sign");
    expect(signValue && signValue.length > 0).toBe(true);
  });

  it("does not fire when the engine is disabled even with crossing metrics", async () => {
    const { aggregator, createAlertEngine } = await setup();
    for (let i = 0; i < 10; i += 1) {
      aggregator.ingest(makeEvent("model.call.error"), Date.now());
    }
    const recorder = installFetchRecorder();
    const engine = createAlertEngine({
      aggregator,
      initialConfig: {
        enabled: false,
        evaluationIntervalSec: 30,
        channels: { hook: { kind: "webhook", url: "https://example.test/hook" } },
        rules: [
          {
            id: "r1",
            name: "errors high",
            metric: "modelErrors",
            window: "5m",
            op: ">",
            threshold: 5,
            channels: ["hook"],
          },
        ],
      },
    });
    try {
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(0);
      expect(recorder.calls).toHaveLength(0);
    } finally {
      recorder.restore();
    }
  });
});
