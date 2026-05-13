import { describe, expect, it } from "vitest";
import { createAggregator } from "./aggregator.js";
import { createRunsTracker } from "./runs-tracker.js";
import { makeEvent } from "../test-utils.js";

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
    agg.ingest(makeEvent("message.delivery.error", { channel: "telegram", durationMs: 50 }), now);
    const channels = agg.channels();
    expect(channels[0]?.key).toBe("telegram");
    expect(channels[0]?.total).toBe(2);
    expect(channels[0]?.errors).toBe(1);
  });

  it("rolls up tool execution stats", () => {
    const agg = createAggregator();
    const now = Date.now();
    agg.ingest(makeEvent("tool.execution.completed", { toolName: "shell", durationMs: 10 }), now);
    agg.ingest(makeEvent("tool.execution.blocked", { toolName: "shell" }), now);
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
    tracker.ingest(makeEvent("harness.run.started", { runId: "r1", channel: "telegram" }), start);
    tracker.ingest(makeEvent("model.call.completed", { runId: "r1", model: "gpt-4" }), start + 10);
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
