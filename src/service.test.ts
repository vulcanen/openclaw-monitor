import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("event fanout", () => {
  it("propagates an injected event to buffer + aggregator + bus + store", () => {
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const fanout = createEventFanout({ buffer, bus, storeRef, aggregator, runsTracker });

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
